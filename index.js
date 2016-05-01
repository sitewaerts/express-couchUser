// # expressUserCouchDb
//
// This module is an express plugin module, which means you can
// require the module in your express app, and add it to your express
// application by using `app.use(user(config));`
//
var express = require('express');
var nano = require('nano');
var uuid = require('uuid');
var emailTemplates = require('email-templates');
var EmailTemplate = emailTemplates.EmailTemplate;
var nodemailer = require('nodemailer');
var _ = require('underscore');
var only = require('only');
var path = require('path');

module.exports = function(config) {
  var app = express(),
    db,
    safeUserFields = config.safeUserFields ? config.safeUserFields : "name email roles",
    apiPrefix = config.apiPrefix || '/api/user';

  function configureNano(cookie) {
    return nano({
      url: config.users,
      requestDefaults: config.request_defaults,
      cookie: cookie
    });
  }

  db = configureNano();

  var transport;
  if(config.email)
  {
    if (!config.email.getEmailLocale) {
      config.email.getEmailLocale = function(user, req, cb) {
        cb(null, null);
      };
    }
    
    
    try {
      transport = nodemailer.createTransport(config.email.nodemailer);

    } catch (err) {
      console.log('*** Email Service is not configured ***');
    }
  }
  else {
    console.log('*** Email Service is not configured ***');
  }

  config.app = config.app || {};

  if (!config.populateUser) {
    config.populateUser = function(req, cb) {
        delete req.body.confirm_password;
        cb(null, req.body);
    };
  }

  if (!config.populateVerifiedUser) {
    config.populateVerifiedUser = function(user, cb) {
        cb();
    };
  }

  if (!config.validateUser) {
    config.validateUser = function(input, cb) {
      cb();
    };
  }


  // required properties on req.body
  // * String: name
  // * String: password
  // * String: email
  // * Array of Strings: roles
  //
  // ### note: you can add more properties to
  // your user registration object
  app.post(apiPrefix + '/signup', function(req, res) {

    config.populateUser(req, function(error, userData){
        if(error)
        {
            error.ok = false;
            res.status(err.statusCode ? err.statusCode : 500).send(error);
            return;
        }

        if (!userData || !userData.name || !userData.password || !userData.email || !userData.roles) {
            res.status(400).send({ok : false, code : 'missing_params', message: 'A name, password, email address and roles are required.'});
            return;
        }

        storeUser(userData);
    });

    function storeUser(userData){
      userData.type = 'user';

      // Check to see whether a user with the same email address already exists.  Throw an error if it does.
      db.view('user', 'all', { key: userData.email }, function(err, body) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
        if (body.rows && body.rows.length > 0) {
          return res.status(400).send({ok: false, code : 'email_already_exists', message: "A user with this email address already exists. Try resetting your password instead."});
        }

        // We can now safely create the user.
        db.insert(userData, 'org.couchdb.user:' + userData.name, done);
      });

      function done(err, body) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

        if (config.verify) {
          try {
            validateUserByEmail(userData.email, req);
            db.get(body._id, function(err,user) {
              if (err) { return res.status(err.statusCode).send(err); }
              res.status(200).send(JSON.stringify({ok: true, user: strip(user)}));
            });
          }
          catch (email_err) {
            res.status(err.statusCode ? err.statusCode : 500).send(email_err);
          }
        } else {
          res.status(200).send(JSON.stringify( _.extend(userData, {_rev: body.rev, ok: true} ) ));
        }
      }
    }
  });

  // login user
  // required properties on req.body
  // * name
  // * password
  app.post(apiPrefix + '/signin', function(req, res) {
    if (!req.body || !req.body.name || !req.body.password) {
      return res.status(400).send(JSON.stringify({ok: false, message: 'A name, and password are required.'}));
    }

    db.auth(req.body.name, req.body.password, populateSessionWithUser(function(err, user) {
      if (err) {
        return res.status(err.statusCode ? err.statusCode : 500).send({ok: false, message: err.message, error: err.error});
      }

      res.end(JSON.stringify({ok:true, user: strip(user)}));
    }));

    function populateSessionWithUser(cb) {
      return function(err, body, headers) {
        if (err) { return cb(err); }
        getUserName(body.name, headers['set-cookie'], function(err, name) {
          if (err) { return cb(err); }

          lookupUser(name, function(err, user) {
            if(err) { return cb(err); }

            if (config.verify && !user.verified) {
              return cb({statusCode: 401, ok: false, message: 'You must verify your account before you can log in.  Please check your email (including spam folder) for more details.'});
            }

            if(user.enabled === false) {
              return cb({statusCode: 403, ok: false, message: 'Your account is no longer enabled.  Please contact an Administrator to enable your account.'});
            }

            config.validateUser({req: req, user: user, headers: headers}, function(err, data) {
              if(err) {
                err.statusCode = err.statusCode || 401;
                err.message = err.message || 'Invalid User Login';
                err.error = err.error || 'unauthorized';
                return cb(err);
              }

              createSession(user, data, function(){
                cb(null, user);
              });

            });

          });
        });

      };
    }

    function getUserName(name, authCookie, cb) {
      if (name) {
        cb(null, name);
      } else {
        /**
         * Work around for issue:  https://issues.apache.org/jira/browse/COUCHDB-1356
         * Must fetch the session after authentication in order to find username of server admin that logged in
         */
        configureNano(authCookie).session(function(err, session) {
          cb(err, session.userCtx.name);
        });
      }
    }

    function lookupUser(name, cb) {
      db.get('org.couchdb.user:' + name, cb);
    }

    function createSession(user, data, cb) {
      req.session.regenerate(function() {
        req.session.user = user;
        if(data) {
          _.each(data, function(val, key) {
            req.session[key] = val;
          });
        }
        cb();
      });
    }

});

  // logout user
  // required properties on req.body
  // * name
  app.post(apiPrefix + '/signout', function(req, res) {
    req.session.destroy(function (err) {
      if (err) {
        console.log('Error destroying session during logout' + err);
      }
      res.status(200).send(JSON.stringify({ok: true, message: "You have successfully logged out."}));
    });
  });


  // forgot user password
  // required properties on req.body
  // * email
  app.post(apiPrefix + '/forgot', function(req,res) {
    if (!req.body || !req.body.email) {
      return res.status(400).send(JSON.stringify({ok: false, message: 'An email address is required.'}));
    }

    var user;
    // use email address to find user
    db.view('user', 'all', { key: req.body.email }, saveUser);

    // generate uuid code
    // and save user record
    function saveUser(err, body) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

      if (body.rows && body.rows.length === 0) {
        return res.status(500).send(JSON.stringify({ ok: false, message: 'No user found with that email.' }));
      }

      user = body.rows[0].value;

      if(user.enabled === false) {
        return res.status(403).send(JSON.stringify({ok: false, message: 'Your account is no longer enabled.  Please contact an Administrator to enable your account.'}));
      }

      // generate uuid save to document
      user.code = uuid.v1();
      db.insert(user, user._id, createEmail);
    }

    // initialize the emailTemplate engine
    function createEmail(err, body) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500, err); }
      if (!transport) { return res.status(500, { error: 'transport is not configured!'}); }
      config.app.url = 'http://' + req.headers.host; // needed for backward compatibility only
      
      getEmailTemplate(user, req, 'forgot', function(err, template){
        if (err) { return res.status(err.statusCode ? err.statusCode : 500, err); }
        template.render({ user: user, app: config.app, req : req}, sendEmail);
      });
    }

    // send rendered template to user
    function sendEmail(err, result) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500, err); }
      transport.sendMail({
        from: config.email.from,
        to: user.email,
        subject: result.subject || config.app.name + ': Reset Password Request',
        html: result.html,
        text: result.text }, done);
    }

    // complete action
    function done(err, status) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500, err); }
      res.status(200).send(JSON.stringify({ ok: true, message: "forgot password link sent..." }));
      //app.emit('user: forgot password', user);
    }
  });


app.get(apiPrefix + '/code/:code', function(req, res) {
  if (!req.params.code) {
    return res.status(500).send(JSON.stringify({ok: false, message: 'You must provide a code parameter.'}));
  }

  db.view('user', 'code', {key: req.params.code}, function(err, body) {
    if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
    if (body.rows.length > 1) {
      return res.status(500).send(JSON.stringify({ ok: false, message: 'More than one user found.'}));
    } else if (body.rows.length === 0) {
      return res.status(500).send(JSON.stringify({ok: false, message: 'Reset code is not valid.'}));
    } else {
      var user = body.rows[0].value;
      var name = user.name;
      if (user.fname && user.lname) {
        name = user.fname + ' ' + user.lname;
      }
      return res.status(200).send(JSON.stringify({ok: true, user: strip(user) }));
    }
  });
});

    // reset user password
    // required properties on req.body
    // * code (generated by /api/user/forgot)
    // * password
    app.post(apiPrefix + '/reset', function(req, res) {
      if (!req.body || !req.body.code || !req.body.password) {
        return res.status(400).send(JSON.stringify({ok: false, message: 'A password and valid password reset code are required.'}));
      }

      // get user by code
      db.view('user', 'code', { key: req.body.code }, checkCode);
      function checkCode(err, body) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
        if (body.rows && body.rows.length === 0) {
          return res.status(500).send(JSON.stringify({ok: false, message: 'Not Found'}));
        }
        var user = body.rows[0].value;
        user.password = req.body.password;
      // clear code
      delete user.code;
      db.insert(user, user._id, function(err,user) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
        return res.status(200).send(JSON.stringify({ok: true, user: strip(user) }));
      });
    }
  });

    // Send (or resend) verification code to a user's email address
    // required properties on req.body
    // * email
    app.post(apiPrefix + '/verify', function(req, res) {
      if (!req.body || !req.body.email) {
        return res.status(400).send(JSON.stringify({ok: false, message: 'An email address must be passed as part of the query string before a verification code can be sent.'}));
      }

      try {
        validateUserByEmail(req.body.email, req);
        res.status(200).send(JSON.stringify({ok:true, message: "Verification code sent..."}));
      }
      catch (validate_err) {
        res.status(validate_err.statusCode).send(validate_err);
      }
    });


    // Accept a verification code and flag the user as verified.
    // required properties on req.params
    // * code
    app.get(apiPrefix + '/verify/:code', function(req,res) {
      if (!req.params.code) {
        return res.status(400).send(JSON.stringify({ok: false, message: 'A verification code is required.'}));
      }

      var user;
        // use verification code
        db.view('user', 'verification_code', { key: req.params.code }, saveUser);

        function saveUser(err, body) {
          if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

          if (body.rows && body.rows.length === 0) {
            return res.status(400).send(JSON.stringify({ ok: false, message: 'Invalid verification code.' }));
          }

            // TODO:  Add an expiration date for the verification code and check it.

            user = body.rows[0].value;
            if (!user.verification_code || user.verification_code !== req.params.code) {
              return res.status(400).send(JSON.stringify({ ok: false, message: 'The verification code you attempted to use does not match our records.' }));
            }

            delete user.verification_code;
            user.verified = new Date();

            config.populateVerifiedUser(user, function(err){
                if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
                db.insert(user, user._id, function(err, body) {
                  if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
                  return res.status(200).send(JSON.stringify({ok:true, message: "Account verified."}));
                });
            });
          }
        });

    // Return the name of the currently logged in user.
    app.get(apiPrefix + '/current', function(req, res) {
      if (!req.session || !req.session.user) {
        return res.status(401).send(JSON.stringify({ok:false, message: "Not currently logged in."}));
      }

      res.status(200).send(JSON.stringify({ok: true, user: strip(req.session.user)}));
    });

  // Look up another user's information
  app.get(apiPrefix + '/:name', function(req, res) {
    if (!req.session || !req.session.user) {
      return res.status(401).send(JSON.stringify({ok:false, message: "You must be logged in to use this function."}));
    }

    db.get('org.couchdb.user:' + req.params.name, function(err,user) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
      return res.status(200).send(JSON.stringify({ok: true, user: strip(user) }));
    });
  });

  // Create a new user or update an existing user
  app.put(apiPrefix + '/:name', function(req, res) {
    if (!req.session || !req.session.user) {
      return res.status(401).send(JSON.stringify({ ok:false, message: "You must be logged in to use this function"}));
    }
    else if (config.adminRoles && !hasAdminPermission(req.session.user) && req.session.user.name !== req.params.name) {
      return res.status(403).send(JSON.stringify({ok:false, message: "You do not have permission to use this function."}));
    }

    db.get('org.couchdb.user:' + req.params.name, function(err, user) {
      if (err) { return res.status( err.statusCode ? err.statusCode : 500).send(err); }
      var updates = strip(req.body);

      var keys = Object.keys(updates);
      for (var i in keys) {
        var key = keys[i];
        if (key === "roles" && !hasAdminPermission(req.session.user)) {
          console.log("Stripped updated role information, non-admin users are not allowed to change roles.");
        } else {
          user[key] = updates[key];
        }
      }

      db.insert(user, 'org.couchdb.user:' + req.params.name, function(err, data) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

        user._rev = data.rev;

        // If a user updates their record, we need to update the session data
        if (req.session.user.name === req.params.name) {
          req.session.user = strip(user);
        }

        return res.status(200).send(JSON.stringify({ok: true, user: strip(user) }));
      });
    });
  });

  // Delete a user
  app.delete(apiPrefix + '/:name', function(req,res) {
    if (!req.session || !req.session.user) {
      return res.status(401).send(JSON.stringify({ok: false, message: "You must be logged in to use this function"}));
    }
    else if (config.adminRoles && !hasAdminPermission(req.session.user)) {
      return res.status(403).send(JSON.stringify({ok:false, message: "You do not have permission to use this function."}));
    }
    db.get('org.couchdb.user:' + req.params.name, function(err,user) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

      db.destroy(user._id, user._rev, function(err,body) {
        if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }

        function respondUserDeleted() {
          res.status(200).send(JSON.stringify({ok: true, message: "User " + req.params.name + " deleted."}));
        }
        // Admins can delete their own accounts, but this will log them out.
        if (req.session.user.name === req.params.name) {
          req.session.destroy(function(err) {
            if (err) {
              console.log('Error destroying session for ' + req.params.name + ' ' + err);
            }
            respondUserDeleted();
          });
        } else {
          respondUserDeleted();
        }

      });
    });
  });

  // Create a user
  app.post(apiPrefix + '', function(req, res) {
    if (!req.session || !req.session.user) {
      return res.status(401).send(JSON.stringify({ok:false, message: "You must be logged in to use this function"}));
    }
    else if (config.adminRoles && !hasAdminPermission(req.session.user)) {
      return res.status(403).send(JSON.stringify({ok:false, message: "You do not have permission to use this function."}));
    }
    req.body.type = 'user';
    db.insert(req.body, 'org.couchdb.user:' + req.body.name, function(err, data) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
      res.status(200).send(JSON.stringify({ok: true, data: data}));
    });
  });

  // Return a list of users matching one or more roles
  app.get(apiPrefix + '', function(req, res) {
    if (!req.session || !req.session.user) {
      return res.status(401).send(JSON.stringify({ok:false, message: "You must be logged in to use this function"}));
    }
    if (!req.query.roles) { return res.status(400).send(JSON.stringify({ok:false, message: 'Roles are required!'})); }
    var keys = req.query.roles.split(',');
    db.view('user', 'role', {keys: keys}, function(err, body) {
      if (err) { return res.status(err.statusCode ? err.statusCode : 500).send(err); }
      var users = _(body.rows).pluck('value');
      res.status(200).send(JSON.stringify({ok: true, users: stripArray(users)}));
    });
  });

  function strip(value) {
    return only(value, safeUserFields);
  }

  function stripArray(array) {
    var returnArray = [];
    array.forEach(function(value) { returnArray.push(only(value, safeUserFields)); });
    return returnArray;
  }

  function hasAdminPermission(user) {
        // If admin roles are disabled, then everyone has admin permissions
        if (!config.adminRoles) { return true; }

        if (user.roles) {
          for (var i in user.roles) {
            var role = user.roles[i];
            if (config.adminRoles instanceof String) {
              if (config.adminRoles === role) { return true; }
            }
            else if (config.adminRoles instanceof Array) {
              if (config.adminRoles.indexOf(role) >= 0) { return true; }
            }
            else {
              console.log("config.adminRoles must be a String or Array.  Admin checks are disabled until this is fixed.");
              return true;
            }
          }
        }

        return false;
      }

      function validateUserByEmail(email, req) {
        var user;
        // use email address to find user
        db.view('user', 'all', { key: email }, saveUserVerificationDetails);

        function saveUserVerificationDetails(err, body) {
          if (err) { throw(err); }

          if (body.rows && body.rows.length === 0) {
            var error = new Error('No user found with the specified email address.');
            error.statusCode = 404;
            throw(error);
          }

          user = body.rows[0].value;
            // TODO:  Add an expiration date for the verification code and check it.
            user.verification_code = uuid.v1();
            db.insert(user, user._id, verificationEmail);
          }

        // initialize the emailTemplate engine
        function verificationEmail(err, body) {
          if (err) { throw(err); }
          if (!transport) {
            var error = new Error('Mail transport is not configured!');
            error.statusCode = 500;
            throw(error);
          }
          config.app.url = 'http://' + req.headers.host; // needed for backward compatibility only

          getEmailTemplate(user, req, 'confirm', function(err, template){
            if (err)
            {
              var error = new Error('Cannot load template');
              error.nested = err;
              throw(error);
            }
            template.render({ user: user, app: config.app, req : req}, sendVerificationEmail);
          });
        }

        // send rendered template to user
        function sendVerificationEmail(err, result) {
          if (err) { throw(err); }
          if (!transport) {
            var error = new Error('Mail transport is not configured!');
            error.statusCode = 500;
            throw(error);
          }
          transport.sendMail({
            from: config.email.from,
            to: user.email,
            subject: result.subject || config.app.name + ': Please Verify Your Account',
            html: result.html,
            text: result.text }, done);
        }

        // complete action
        function done(err, status) {
          if (err) { throw(err); }
            //app.emit('user: verify account', user);
          }
        }


        function getEmailTemplate(user, req, type, cb)
        {
          config.email.getEmailLocale(user, req, function(err, locale){
            if(err)
              return cb(err);
            if(!locale)
              return cb(null, new EmailTemplate(path.join(config.email.templateDir, type)));
            return cb(null, new EmailTemplate(path.join(config.email.templateDir, type, locale)));
          });
        }

        return app;
      };   

