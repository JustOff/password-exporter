/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/.
 **/

/**
 * Password Exporter - Login Manager support
 * This file is for use with the new login manager in Firefox 3
 */
const { classes: Cc, interfaces: Ci, results: Cr, utils: Cu } = Components;

Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "Sqlite",
                                  "resource://gre/modules/Sqlite.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "OSCrypto",
                                  "chrome://pwdbackuptool/content/OSCrypto.jsm");

const AUTH_TYPE = {
  SCHEME_HTML: 0,
  SCHEME_BASIC: 1,
  SCHEME_DIGEST: 2
};

var passwordExporterLoginMgr = {
    export: {
        currentExport: '', // CSV or XML string of current export
        count: 0, // count of exported logins
        errorCount: 0, // count of failed logins
        failed: '', // failed hosts

        // starts export of saved passwords to XML/CSV file
        start: function() {
            passwordExporter.debug('Starting Export...');

            let masterPassword;

            // Check if user has accepted agreement
            passwordExporter.checkAgreement();
            masterPassword = this._showMasterPasswordPrompt();

            if (masterPassword && passwordExporter.accepted == true) {
                var picker = Components.classes["@mozilla.org/filepicker;1"].
                                createInstance(Components.interfaces.nsIFilePicker);
                picker.init(window, PwdEx.getString("passwordexporter.filepicker-title"), picker.modeSave);
                picker.defaultString = "password-export-" + this.getDateString() + ".xml";
                picker.defaultExtension = "xml";
                picker.appendFilter("XML", "*.xml");
                picker.appendFilter("CSV", "*.csv");

                if (picker.returnCancel != picker.show()) {
                    var result = { file : picker.file, type : picker.filterIndex };
                } else {
                    return;
                }

                var stream = Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);

                // Remove file if it exists
                if (result.file.exists()) {
                    result.file.remove(true);
                }

                result.file.create(result.file.NORMAL_FILE_TYPE, parseInt("0666", 8));
                stream.init(result.file, 0x02, 0x200, null);

                // Whether to encrypt the passwords
                var encrypt = document.getElementById('pwdex-encrypt').checked;
                var content = "";
                // do export
                switch (result.type) {
                    case 0:
                        content = this.export('xml', encrypt);
                        break;
                    case 1:
                        content = this.export('csv', encrypt);
                        break;
                }

                stream.write(content, content.length);
                stream.close();

                passwordExporter.debug('Export of ' + this.count + ' entries completed with ' + this.errorCount + ' errors.');

                if (this.errorCount == 0)
                    alert(PwdEx.stringBundle.formatStringFromName('passwordexporter.alert-passwords-exported', [this.count], 1));
                else {
                    var promptService = Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);

                    var flags = promptService.BUTTON_TITLE_OK * promptService.BUTTON_POS_0 +
                    promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_1;

                    var response = promptService.confirmEx(window, PwdEx.stringBundle.GetStringFromName('passwordexporter.name'),
                                    PwdEx.stringBundle.formatStringFromName('passwordexporter.alert-passwords-exported', [this.count], 1) + "\n\n" +
                                    PwdEx.stringBundle.formatStringFromName('passwordexporter.alert-passwords-failed', [this.errorCount], 1), flags,
                                    null, PwdEx.stringBundle.GetStringFromName('passwordexporter.show-details'), null, null, {});

                    if (response == 1)
                        window.openDialog("chrome://pwdbackuptool/content/pwdex-details-export.xul", "","chrome,resizable,centerscreen,close=no,modal");
                }
            }
        },

        // Returns current date in YYYY-MM-DD format for default file names
        getDateString: function() {
            let date = new Date();
            let year = date.getFullYear();
            let month = date.getMonth() + 1;
            let day = date.getDate();
            month = (month < 10 ? '0' + month : month);
            day = (day < 10 ? '0' + day : day);
            return (year + "-" + month + "-" + day);
        },

        // Generates XML/CSV from Login Manager entries
        export: function(type, encrypt) {
            passwordExporter.debug('Generating ' + type + ' entries...');
            if (type == 'xml') {
                this.currentExport = '<xml>' + passwordExporter.linebreak;
                this.currentExport += '<entries ext="Password Exporter" extxmlversion="1.1" type="saved" encrypt="' + encrypt + '">' + passwordExporter.linebreak;
            }
            else if (type == 'csv') {
                this.currentExport = '# Generated by Password Exporter; Export format 1.1; Encrypted: ' + encrypt + passwordExporter.linebreak;
                this.currentExport += '"hostname","username","password","formSubmitURL","httpRealm","usernameField","passwordField"' + passwordExporter.linebreak;
            }

            this.count = 0;
            this.errorCount = 0;
            passwordExporter.failed = '';

            var loginManager = CC_loginManager.getService(Components.interfaces.nsILoginManager);
            var logins = loginManager.getAllLogins({});

            for (var i = 0; i < logins.length; i++) {
                if (type == 'xml') {
                    this.entryToXML(logins[i].hostname, logins[i].formSubmitURL, logins[i].httpRealm, logins[i].username,
                               logins[i].usernameField, logins[i].password, logins[i].passwordField, encrypt);
                }
                else if (type == 'csv') {
                    this.entryToCSV(logins[i].hostname, logins[i].formSubmitURL, logins[i].httpRealm, logins[i].username,
                               logins[i].usernameField, logins[i].password, logins[i].passwordField, encrypt);
                }
            }

            if (type == 'xml') {
                this.currentExport += '</entries>' + passwordExporter.linebreak + '</xml>';
            }

            return this.currentExport;
        },

        // Show the master password prompt if needed. Adapted from:
        // https://dxr.mozilla.org/mozilla-central/rev/88bebcaca249aeaca9197382e89d35b02be8292e/toolkit/components/passwordmgr/content/passwordManager.js#494
        _showMasterPasswordPrompt: function() {
          // This doesn't harm if passwords are not encrypted
          var tokendb =
              Components.classes["@mozilla.org/security/pk11tokendb;1"].
                  createInstance(Components.interfaces.nsIPK11TokenDB);
          var token = tokendb.getInternalKeyToken();

          // If there is no master password, still give the user a chance to
          // opt-out of displaying passwords
          if (token.checkPassword(""))
            return true;

          // So there's a master password. But since checkPassword didn't
          //  succeed, we're logged out (per nsIPK11Token.idl).
          try {
            // Relogin and ask for the master password.
            // 'true' means always prompt for token password. User will be
            // prompted until clicking 'Cancel' or entering the correct
            // password.
            token.login(true);
          } catch (e) {
            // An exception will be thrown if the user cancels the login prompt
            // dialog. User is also logged out of Software Security Device.
          }

          return token.isLoggedIn();
        },

        // Records an nsILoginInfo entry to XML
        entryToXML: function(hostname, formSubmitURL, httpRealm, username, usernameField,
                            password, passwordField, encrypt) {
            if (encrypt) {
                username = btoa(username);
                password = btoa(password);
            }

            try {
                var xml  = '<entry';
                xml += ' host="' + this.escapeQuote(hostname) + '"';
                xml += ' user="' + this.escapeQuote(username) + '"';
                xml += ' password="' + this.escapeQuote(password) + '"';

                xml += ' formSubmitURL="' + (formSubmitURL ? this.escapeQuote(formSubmitURL) : '') + '"';
                xml += ' httpRealm="' + (httpRealm ? this.escapeQuote(httpRealm) : '') + '"';
                xml += ' userFieldName="' + (usernameField ? this.escapeQuote(usernameField) : '') + '"';
                xml += ' passFieldName="' + (passwordField ? this.escapeQuote(passwordField) : '') + '"';

                xml += '/>' + passwordExporter.linebreak;

                this.currentExport += xml;
                this.count++;
            } catch (e) {
                this.errorCount++;
                try {
                    this.failed += hostname + passwordExporter.linebreak;
                } catch (e) { }
            }
        },

        // Records an nsILoginInfo entry to CSV
        entryToCSV: function(hostname, formSubmitURL, httpRealm, username, usernameField,
                            password, passwordField, encrypt) {
            if (encrypt) {
                username = btoa(username);
                password = btoa(password);
            }

            try {
                var csv = '"' + this.escapeQuote(hostname) + '",';
                csv += '"' + this.escapeQuote(username) + '",';
                csv += '"' + this.escapeQuote(password) + '",';

                csv += '"' + (formSubmitURL ? this.escapeQuote(formSubmitURL) : '') + '",';
                csv += '"' + (httpRealm ? this.escapeQuote(httpRealm) : '') + '",';
                csv += '"' + (usernameField ? this.escapeQuote(usernameField) : '') + '",';
                csv += '"' + (passwordField ? this.escapeQuote(passwordField) : '')+ '"';

                csv += passwordExporter.linebreak;

                this.currentExport += csv;
                this.count++;
            } catch (e) {
                this.errorCount++;
                try {
                    this.failed += hostname + passwordExporter.linebreak;
                } catch (e) { }
            }
        },

        // escapes only quotes and ampersands so that it will parse correctly in XML
        escapeQuote: function(string) {
            string = string.replace(/%/gi, '%25');
            string = string.replace(/</gi, '%3C');
            string = string.replace(/>/gi, '%3E');
            string = string.replace(/"/gi, '%22');
            string = string.replace(/&/gi, '%26');

            return string;
        },

        // populate details textbox with failed entries
        populateFailed: function(textbox) {
            textbox.value = this.failed;
        },

        disabled: {
            // starts export of login disabled sites that never saved passwords
            start: function() {
                passwordExporter.debug('Starting Disabled Hosts Export...');
                var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
                var stream = Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);

                fp.init(window, PwdEx.stringBundle.GetStringFromName('passwordexporter.filepicker-title'), fp.modeSave);
                fp.defaultString = 'disabled-export-' + passwordExporter.getDateString();
                fp.defaultExtension = '.xml';
                fp.appendFilters(fp.filterXML);

                // If cancelled, return
                if (fp.show() == fp.returnCancel)
                    return;

                if (fp.file.exists())
                    fp.file.remove(true);

                fp.file.create(fp.file.NORMAL_FILE_TYPE, parseInt("0666", 8));
                stream.init(fp.file, 0x02, 0x200, null);

                var xml = this.export();

                stream.write(xml, xml.length);
                stream.close();

                passwordExporter.debug('Disabled hosts export complete.');

                alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-rejected-exported'));
            },

            // Gets disabled hosts from Login Manager
            export: function() {
                var xml = '<xml>' + passwordExporter.linebreak;
                xml += '<entries ext="Password Exporter" extxmlversion="1.0.2" type="rejected">' + passwordExporter.linebreak;

                var loginManager = CC_loginManager.getService(Components.interfaces.nsILoginManager);
                var disabledHosts = loginManager.getAllDisabledHosts({});

                for (var i = 0; i < disabledHosts.length; i++) {
                    xml += '<entry host="' + disabledHosts[i] + '"/>' + passwordExporter.linebreak;
                }

                xml += '</entries>' + passwordExporter.linebreak + '</xml>';

                return xml;
            }
        }

    },

    import: {
        totalCount: 0, // total number of logins
        currentCount: 0, // number of logins currently imported
        cancelled: false, // whether the operation was cancelled
        failed: '', // list of failed hosts

        // Starts the import of logins from a CSV or XML file
        start: function() {
            passwordExporter.debug('Starting Import...');

            var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
            var stream = Components.classes["@mozilla.org/network/file-input-stream;1"].createInstance(Components.interfaces.nsIFileInputStream);
            var streamIO = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
            var input, inputArray, importType, doc, header, name, type, version, encrypt;

            fp.init(window, PwdEx.stringBundle.GetStringFromName('passwordexporter.filepicker-title'), fp.modeOpen);
            fp.appendFilter(PwdEx.stringBundle.GetStringFromName('passwordexporter.filepicker-open-xmlcsv'), '*.xml; *.csv; *');

            // If cancelled, return
            if (fp.show() == fp.returnCancel)
                return;

            if (fp.file.path.indexOf('.csv') != -1 || fp.file.path.indexOf('.xml') != -1) {
                stream.init(fp.file, 0x01, parseInt("0444", 8), null);
                streamIO.init(stream);
                input = streamIO.read(stream.available());
                streamIO.close();
                stream.close();
            }

            // If CSV format, parse for header info
            if (fp.file.path.indexOf('.csv') != -1) {
                // Starting in 1.1, header is in a "comment" at the top
                var header = /# Generated by (.+); Export format (.{3,6}); Encrypted: (true|false)/i.exec(input);
                if (!header) {
                    // Previously, the header was in CSV form in the first line
                    header = /(.+?),(.{3,6}),(true|false)/i.exec(input);
                }
                if (!header) {
                    // If we still can't read header, there's a problem with the file
                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-cannot-import'));
                    return;
                }
                var properties = {'extension': header[1],
                                  'importtype': 'saved',
                                  'importversion': header[2],
                                  'encrypt': header[3]};
                this.import('csv', properties, input);
            }
            // If XML format, parse for header info
            else if (fp.file.path.indexOf('.xml') != -1) {
                var parser = new DOMParser();
                var doc = parser.parseFromString(input, "text/xml");
                var header = doc.documentElement.getElementsByTagName('entries')[0];

                if (doc.documentElement.nodeName == 'parsererror') {
                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-xml-error'));
                    return;
                }

                var properties = {'extension': header.getAttribute('ext'),
                                  'importtype': header.getAttribute('type'),
                                  'importversion': header.getAttribute('extxmlversion'),
                                  'encrypt': header.getAttribute('encrypt')};
                var entries = doc.documentElement.getElementsByTagName('entry');
                this.import('xml', properties, entries);
            // Chrome style Login Data
            } else {
                let that = this;
                this.getRowsFromDBWithoutLocks(fp.file.path, "Chrome passwords",
                    `SELECT origin_url, action_url, username_element, username_value,
                    password_element, password_value, signon_realm, scheme, date_created,
                    times_used FROM logins WHERE blacklisted_by_user = 0`).then((rows) => {
                    var properties = {'extension': 'Password Exporter',
                                    'importtype': 'saved',
                                    'importversion': '1.1',
                                    'encrypt': 'false'};
                    that.import('chrome', properties, rows);
                }).catch(ex => {
//                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-cannot-import'));
                    alert(ex);
                    that.finished();
                });
            }
        },

        // Validates import file and parses it
        import: function (type, properties, entries) {
            passwordExporter.debug(type + ' file read...');

            // Make sure this is a Password Exporter export
            if (properties.extension != 'Password Exporter') {
                alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-cannot-import'));
                return;
            }

            // Make sure this is a saved passwords file, as opposed to disabled hosts
            if (properties.importtype != 'saved') {
                alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-wrong-file-reject'));
                return;
            }

            // Make sure this was exported from a version supported (not a future version)
            if (properties.importversion in {'1.0.2':'', '1.0.4':'', '1.1':''}) {
                // Import
                var logins = [];
                this.totalCount = 0;
                this.currentCount = 0;

                passwordExporter.disableAllButtons();
                document.getElementById('pwdex-import-finished').hidden = true;
                document.getElementById('pwdex-import-view-details').hidden = true;
                document.getElementById('pwdex-import-complete').hidden = true;
                document.getElementById('pwdex-import-cancelled').hidden = true;
                document.getElementById('pwdex-import-status').value = '';
                document.getElementById('pwdex-import-underway').hidden = false;
                document.getElementById('pwdex-import-cancel').hidden = false;

                var loginManager = CC_loginManager.getService(Components.interfaces.nsILoginManager);
                var nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
                                         Components.interfaces.nsILoginInfo, "init");
                if (type == 'xml') {
                    this.totalCount = entries.length;

                    if (properties.importversion == '1.0.2' || properties.importversion == '1.0.4')
                        var emptySubmitURL = "";
                    else
                        var emptySubmitURL = null;

                    for (var i = 0; i < entries.length; i++) {
                        var loginInfo = new nsLoginInfo(
                                                (entries[i].getAttribute('host') == null ? null : unescape(entries[i].getAttribute('host'))),
                                                (entries[i].getAttribute('formSubmitURL') == null ? emptySubmitURL : unescape(entries[i].getAttribute('formSubmitURL'))),
                                                ((entries[i].getAttribute('httpRealm') == null || entries[i].getAttribute('httpRealm') == "") ? null : unescape(entries[i].getAttribute('httpRealm'))),
                                                unescape(entries[i].getAttribute('user')),
                                                unescape(entries[i].getAttribute('password')),
                                                (entries[i].getAttribute('userFieldName') == null ? "" : unescape(entries[i].getAttribute('userFieldName'))),
                                                (entries[i].getAttribute('passFieldName') == null ? "" : unescape(entries[i].getAttribute('passFieldName')))
                                            );

                        var formattedLogins = this.getFormattedLogin(properties, loginInfo);
                        for each (var login in formattedLogins) {
                            logins.push(login);
                        }
                    }
                }
                else if (type == 'csv') {
                    if (/\r\n/i.test(entries))
                        var entryArray = entries.split("\r\n");
                    else if (/\r/i.test(entries))
                        var entryArray = entries.split("\r");
                    else
                        var entryArray = entries.split("\n");

                    // Prior to version 1.1, we only had one line of header
                    // After 1.1, there was a header comment and a labels line
                    if (properties.importversion == '1.0.2' || properties.importversion == '1.0.4')
                        var start = 1;
                    else
                        var start = 2;

                    for (var i = start; i < (entryArray.length - 1); i++) {
                        if (properties.importversion == '1.0.2' || properties.importversion == '1.0.4') {
                            // Before version 1.1, csv didn't have quotes
                            var fields = entryArray[i].split(',');

                            var loginInfo = new nsLoginInfo(
                                                    (fields[0] == '' ? null : unescape(fields[0])),// hostname
                                                    "", // formSubmitURL
                                                    null, // httpRealm
                                                    unescape(fields[1]), // username
                                                    unescape(fields[2]), // password
                                                    unescape(fields[3]), // usernameField
                                                    unescape(fields[4]) // passwordField
                                                );
                        }
                        else {
                            // Version 1.1 CSV has quotes and 2 new fields
                            var fields = entryArray[i].split('","');

                            var loginInfo = new nsLoginInfo(
                                                    (fields[0] == '"' ? null : unescape(fields[0].replace('"', ''))), // hostname
                                                    (fields[3] == '' ? null : unescape(fields[3])), // formSubmitURL
                                                    (fields[4] == '' ? null : unescape(fields[4])), // httpRealm
                                                    unescape(fields[1]), // username
                                                    unescape(fields[2]), // password
                                                    unescape(fields[5]), // usernameField
                                                    unescape(fields[6].replace('"', '')) // passwordField
                                                );
                        }

                        var formattedLogins = this.getFormattedLogin(properties, loginInfo);
                        for each (var login in formattedLogins) {
                            logins.push(login);
                        }
                    }
                } else {
                    let crypto = new OSCrypto();
                    for (let row of entries) {
                        try {
                            let li = {
                                username: row.getResultByName("username_value"),
                                password: crypto.
                                        decryptData(crypto.arrayToString(row.getResultByName("password_value")),null),
                                hostName: NetUtil.newURI(row.getResultByName("origin_url")).prePath,
                                submitURL: null,
                                httpRealm: null,
                                usernameElement: row.getResultByName("username_element"),
                                passwordElement: row.getResultByName("password_element")
                            };

                            switch (row.getResultByName("scheme")) {
                                case AUTH_TYPE.SCHEME_HTML:
                                    li.submitURL = NetUtil.newURI(row.getResultByName("action_url")).prePath;
                                    break;
                                case AUTH_TYPE.SCHEME_BASIC:
                                case AUTH_TYPE.SCHEME_DIGEST:
                                    // signon_realm format is URIrealm, so we need remove URI
                                    li.httpRealm = row.getResultByName("signon_realm")
                                                            .substring(li.hostName.length + 1);
                                    break;
                                default:
                                    throw new Error("Login data scheme type not supported: " +
                                                        row.getResultByName("scheme"));
                            }

                            var loginInfo = new nsLoginInfo(li.hostName, li.submitURL, li.httpRealm, li.username, 
                                                            li.password, li.usernameElement, li.passwordElement);
                            logins.push(loginInfo);

                        } catch (e) {
                            Cu.reportError(e);
                        }
                    }
                    crypto.finalize();
                }

                this.insertEntries(logins);

                // because of window timers, we can't put post-insert steps here
                // they are now located in passwordExporterLoginMgr.import.finished()
            }
            else
                alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-wrong-version'));
        },

        // Makes sure logins are formatted correctly for Firefox 3
        getFormattedLogin: function(properties, loginInfo) {
            passwordExporter.debug('pre-getFormattedLogin: [hostname: ' + loginInfo.hostname + ', httpRealm: ' + loginInfo.httpRealm + ', formSubmitURL: ' + loginInfo.formSubmitURL + ', usernameField: ' + loginInfo.usernameField + ', passwordField: ' + loginInfo.passwordField + ']');

            // in version 1.0.2, encryption was only for passwords... in 1.0.4 we encrypt usernames as well
            if (properties.encrypt == 'true') {
                loginInfo.password = atob(loginInfo.password);

                if (properties.importversion != '1.0.2')
                    loginInfo.username = atob(loginInfo.username);
            }

            // No null usernames or passwords
            if (loginInfo.username == null)
                loginInfo.username = '';
            if (loginInfo.password == null)
                loginInfo.password = '';

            // If no httpRealm, check to see if it's in the hostname
            if (!loginInfo.httpRealm) {
                var hostnameParts = /(.*) \((.*)\)/.exec(loginInfo.hostname);
                if (hostnameParts) {
                    loginInfo.hostname = hostnameParts[1];
                    loginInfo.httpRealm = hostnameParts[2];
                }
            }

            // Convert to 2E (remove httpRealm from hostname, convert protocol logins, etc)
            loginInfo = passwordExporterStorageLegacy._upgrade_entry_to_2E(loginInfo);
            for each (var login in loginInfo) {
                if (login.httpRealm != null)
                    login.formSubmitURL = null;

                passwordExporter.debug('post-getFormattedLogin: [hostname: ' + login.hostname + ', httpRealm: ' + login.httpRealm + ', formSubmitURL: ' + login.formSubmitURL + ', usernameField: ' + login.usernameField + ', passwordField: ' + login.passwordField + ']');
            }

            return loginInfo;
        },

        // Starts the generator to insert the logins
        insertEntries: function(entries) {
            this.totalCount = entries.length;
            this.cancelled = false;
            this.failed = '';

            this.insertGenerator = this.doInsert(entries);
            window.setTimeout("passwordExporter.import.updateProgress()", 0);
        },

        // Updates the progress bar and iterates the generator
        updateProgress: function() {
            var i = this.insertGenerator.next();
            var percentage = Math.floor((this.currentCount / this.totalCount) * 100);
            document.getElementById('pwdex-import-progress').value = percentage;
            document.getElementById('pwdex-import-status').value = this.currentCount + '/' + this.totalCount;

            // If cancelled, don't add another timer
            if (this.cancelled) {
                passwordExporter.import.finished();
                return;
            }
            // Add another timer if there are more logins
            if (i < this.totalCount)
                window.setTimeout("passwordExporter.import.updateProgress()", 0);
            else if (i == this.totalCount)
                passwordExporter.import.finished();
        },

        // Insert the new login into Login Manager
        doInsert: function(entries) {
            var loginManager = CC_loginManager.getService(Components.interfaces.nsILoginManager);
            var nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
                                         Components.interfaces.nsILoginInfo, "init");
            var i = 0;
            while (true) {
                yield i;
                passwordExporter.debug('Adding: [hostname: ' + entries[i].hostname + ', httpRealm: ' + entries[i].httpRealm + ', formSubmitURL: ' + entries[i].formSubmitURL + ', username: ' + entries[i].username + ', usernameField: ' + entries[i].usernameField + ', passwordField: ' + entries[i].passwordField + ']');

                // Fix for issue 39
                if (entries[i].httpRealm) {
                    entries[i].formSubmitURL = null;
                }
                else {
                    entries[i].httpRealm = null;
                }

                var loginInfo = new nsLoginInfo(entries[i].hostname, entries[i].formSubmitURL,
                            entries[i].httpRealm, entries[i].username,
                            entries[i].password, entries[i].usernameField,
                            entries[i].passwordField);
                try {
                    // Add the login
                    loginManager.addLogin(loginInfo);

                    this.currentCount++;
                }
                catch (e) {
                    this.failed += entries[i].hostname + ' (' + e.message + ')' + passwordExporter.linebreak;
                }
                i++;
            }
        },

        // Cancel the import
        cancel: function() {
            this.cancelled = true;
        },

        // Update UI to reflect import completion or cancellation
        finished: function() {
            if (document.getElementById('tabbox')) {
                // Refresh the listbox of passwords only if we are using the tab... the dialog version does not need to
                LoadSignons();
            }
            document.getElementById('pwdex-import-cancel').hidden = true;
            document.getElementById('pwdex-import-finished').hidden = false;

            if (this.cancelled) {
                passwordExporter.debug('Import cancelled by user.');
                document.getElementById('pwdex-import-cancelled').hidden = false;
            }
            else {
                passwordExporter.debug('Import complete.');
                //alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-passwords-imported'));
                document.getElementById('pwdex-import-complete').hidden = false;
            }

            // If there were failed entries, show a details link
            if (this.failed != '')
                document.getElementById('pwdex-import-view-details').hidden = false;

            passwordExporter.enableAllButtons();
        },

        // Open the import details window
        showDetailsWindow: function() {
            window.openDialog("chrome://pwdbackuptool/content/pwdex-details-import.xul", "","chrome,resizable,centerscreen,close=no,modal");
        },

        // populate details textbox with failed entries
        populateFailed: function(textbox) {
            textbox.value = this.failed;
        },

        disabled: {
            // Starts import of disabled hosts from XML file
            start: function() {
                var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
                var stream = Components.classes["@mozilla.org/network/file-input-stream;1"].createInstance(Components.interfaces.nsIFileInputStream);
                var streamIO = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
                var input;

                fp.init(window, PwdEx.stringBundle.GetStringFromName('passwordexporter.filepicker-title'), fp.modeOpen);
                fp.appendFilter(PwdEx.stringBundle.GetStringFromName('passwordexporter.filepicker-open-xml'), '*.xml; *');

                // If canceled, return
                if (fp.show() == fp.returnCancel)
                    return;

                stream.init(fp.file, 0x01, parseInt("0444", 8), null);
                streamIO.init(stream);
                input = streamIO.read(stream.available());
                streamIO.close();
                stream.close();

                var parser = new DOMParser();
                var doc = parser.parseFromString(input, "text/xml");

                var header = doc.documentElement.getElementsByTagName('entries')[0];

                // Return if parser error or no header
                if (doc.documentElement.nodeName == 'parsererror' || !header) {
                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-xml-error'));
                    return;
                }

                // Return if not Password Exporter
                if (header.getAttribute('ext') != 'Password Exporter') {
                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-cannot-import'));
                    return;
                }

                // Make sure it's a disabled hosts file
                if (header.getAttribute('type') != 'rejected') {
                    alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-wrong-file-saved'));
                    return;
                }

                var entries = doc.documentElement.getElementsByTagName('entry');
                this.import(entries);

                if (document.getElementById('tabbox')) {
                    // Refresh the listbox of rejects only if we are using the tab... the dialog version does not need to
                    LoadRejects();
                }

                alert(PwdEx.stringBundle.GetStringFromName('passwordexporter.alert-rejected-imported'));
            },

            // Import disabled hosts
            import: function(entries) {
                var loginManager = CC_loginManager.getService(Components.interfaces.nsILoginManager);

                for (var i = 0; i < entries.length; i++) {
                    loginManager.setLoginSavingEnabled(entries[i].getAttribute('host'), false);
                }
            }
        },

        /**
        * Get all the rows corresponding to a select query from a database, without
        * requiring a lock on the database. If fetching data fails (because someone
        * else tried to write to the DB at the same time, for example), we will
        * retry the fetch after a 100ms timeout, up to 10 times.
        *
        * @param path
        *        the file path to the database we want to open.
        * @param description
        *        a developer-readable string identifying what kind of database we're
        *        trying to open.
        * @param selectQuery
        *        the SELECT query to use to fetch the rows.
        *
        * @return a promise that resolves to an array of rows. The promise will be
        *         rejected if the read/fetch failed even after retrying.
        */
        getRowsFromDBWithoutLocks(path, description, selectQuery) {
            let dbOptions = {
                readOnly: true,
                ignoreLockingMode: true,
                path,
            };

            const RETRYLIMIT = 10;
            const RETRYINTERVAL = 100;
            return Task.spawn(function* innerGetRows() {
                let rows = null;
                for (let retryCount = RETRYLIMIT; retryCount && !rows; retryCount--) {
                    // Attempt to get the rows. If this succeeds, we will bail out of the loop,
                    // close the database in a failsafe way, and pass the rows back.
                    // If fetching the rows throws, we will wait RETRYINTERVAL ms
                    // and try again. This will repeat a maximum of RETRYLIMIT times.
                    let db;
                    let didOpen = false;
                    let exceptionSeen;
                    try {
                        db = yield Sqlite.openConnection(dbOptions);
                        didOpen = true;
                        rows = yield db.execute(selectQuery);
                    } catch (ex) {
                        if (!exceptionSeen) {
                            Cu.reportError(ex);
                        }
                        exceptionSeen = ex;
                    } finally {
                        try {
                            if (didOpen) {
                                yield db.close();
                            }
                        } catch (ex) {}
                    }
                    if (exceptionSeen) {
                        yield new Promise(resolve => setTimeout(resolve, RETRYINTERVAL));
                    }
                }
                if (!rows) {
                    throw new Error("Couldn't get rows from the " + description + " database.");
                }
                return rows;
            });
        }
    }
};
