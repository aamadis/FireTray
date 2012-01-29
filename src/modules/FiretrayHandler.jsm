/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");
Cu.import("resource://firetray/ctypes/gobject.jsm");
Cu.import("resource://firetray/ctypes/gtk.jsm");
Cu.import("resource://firetray/commons.js");
Cu.import("resource://firetray/FiretrayPrefListener.jsm");
Cu.import("resource://firetray/FiretrayVersionChange.jsm");

/**
 * firetray namespace.
 */
if ("undefined" == typeof(firetray)) {
  var firetray = {};
};

/**
 * Singleton object and abstraction for windows and tray icon management.
 */
// NOTE: modules work outside of the window scope. Unlike scripts in the
// chrome, modules don't have access to objects such as window, document, or
// other global functions
// (https://developer.mozilla.org/en/XUL_School/JavaScript_Object_Management)
firetray.Handler = {
  FILENAME_DEFAULT: null,
  FILENAME_SUFFIX: "32.png",
  FILENAME_BLANK: null,
  FILENAME_NEWMAIL: null,

  initialized: false,
  appNameOriginal: null,
  appStarted: false,
  appId: null,
  runtimeOS: null,
  inMailApp: false,
  inBrowserApp: false,
  windows: {},
  windowsCount: 0,
  visibleWindowsCount: 0,

  init: function() {            // does creates icon
    firetray.PrefListener.register(false);

    this.appNameOriginal = Services.appinfo.name;
    this.FILENAME_DEFAULT = firetray.Utils.chromeToPath(
      "chrome://firetray/skin/" +  this.appNameOriginal.toLowerCase() + this.FILENAME_SUFFIX);
    this.FILENAME_BLANK = firetray.Utils.chromeToPath(
      "chrome://firetray/skin/blank-icon.png");
    this.FILENAME_NEWMAIL = firetray.Utils.chromeToPath(
      "chrome://firetray/skin/message-mail-new.png");

    this.runtimeABI = Services.appinfo.XPCOMABI;
    this.runtimeOS = Services.appinfo.OS; // "WINNT", "Linux", "Darwin"
    // version checked during install, so we shouldn't need to care
    let xulVer = Services.appinfo.platformVersion; // Services.vc.compare(xulVer,"2.0a")>=0
    LOG("OS=" + this.runtimeOS + ", ABI=" + this.runtimeABI + ", XULrunner=" + xulVer);
    switch (this.runtimeOS) {
    case "Linux":
      Cu.import("resource://firetray/gtk2/FiretrayStatusIcon.jsm");
      LOG('FiretrayStatusIcon imported');
      Cu.import("resource://firetray/gtk2/FiretrayWindow.jsm");
      LOG('FiretrayWindow imported');
      break;
    default:
      ERROR("FIRETRAY: only Linux platform supported at this time. Firetray not loaded");
      return false;
    }

    this.appId = Services.appinfo.ID;
    if (this.appId === THUNDERBIRD_ID || this.appId === SEAMONKEY_ID)
      this.inMailApp = true;
    if (this.appId === FIREFOX_ID || this.appId === SEAMONKEY_ID)
      this.inBrowserApp = true;
    LOG('inMailApp: '+this.inMailApp+', inBrowserApp: '+this.inBrowserApp);

    firetray.StatusIcon.init();
    firetray.Handler.showHideIcon();
    LOG('StatusIcon initialized');

    if (this.inMailApp) {
      try {
        Cu.import("resource://firetray/FiretrayMessaging.jsm");
        let prefMailNotification = firetray.Utils.prefService.getIntPref("mail_notification");
        if (prefMailNotification !== FT_NOTIFICATION_DISABLED) {
          firetray.Messaging.init();
          firetray.Messaging.updateUnreadMsgCount();
        }
      } catch (x) {
        ERROR(x);
        return false;
      }
    }

    Services.obs.addObserver(this, this.getAppStartupTopic(this.appId), false);
    Services.obs.addObserver(this, "xpcom-will-shutdown", false);

    firetray.VersionChange.watch();

    this.initialized = true;
    return true;
  },

  shutdown: function() {
    firetray.PrefListener.unregister();

    if (this.inMailApp)
      firetray.Messaging.shutdown();
    firetray.StatusIcon.shutdown();
    firetray.Window.shutdown();

    firetray.Utils.tryCloseLibs([gobject, glib, gtk]);

    Services.obs.removeObserver(this, this.getAppStartupTopic(this.appId), false);
    Services.obs.removeObserver(this, "xpcom-will-shutdown", false);

    this.appStarted = false;
    this.initialized = false;
    return true;
  },

  observe: function(subject, topic, data) {
    switch (topic) {
    case "sessionstore-windows-restored":
    case "mail-startup-done":
    case "final-ui-startup":
      LOG("RECEIVED: "+topic+", launching timer");
      // sessionstore-windows-restored does not come after the realization of
      // all windows... so we wait a little
      var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback({ notify: function() {
        firetray.Handler.appStarted = true;
        LOG("*** appStarted ***");
      }}, FIRETRAY_DELAY_BROWSER_STARTUP_MILLISECONDS, Ci.nsITimer.TYPE_ONE_SHOT);
      break;
    case "xpcom-will-shutdown":
      LOG("xpcom-will-shutdown");
      this.shutdown();
      break;
    default:
    }
  },

  getAppStartupTopic: function(id) {
    switch (id) {
    case FIREFOX_ID:
    case SEAMONKEY_ID:
      return 'sessionstore-windows-restored';
    case THUNDERBIRD_ID:
      return 'mail-startup-done';
    default:
      return 'final-ui-startup';
    }
  },

  // these get overridden in OS-specific Icon/Window handlers
  setIconImage: function(filename) {},
  setIconImageDefault: function() {},
  setIconText: function(text, color) {},
  setIconTooltip: function(localizedMessage) {},
  setIconTooltipDefault: function() {},
  setIconVisibility: function(visible) {},
  registerWindow: function(win) {},
  unregisterWindow: function(win) {},
  getWindowIdFromChromeWindow: function(win) {},
  hideSingleWindow: function(winId) {},
  showSingleWindow: function(winId) {},
  showHideAllWindows: function() {},

  showAllWindows: function() {
    LOG("showAllWindows");
    for (let winId in firetray.Handler.windows) {
      if (!firetray.Handler.windows[winId].visibility)
        firetray.Handler.showSingleWindow(winId);
    }
  },
  hideAllWindows: function() {
    LOG("hideAllWindows");
    for (let winId in firetray.Handler.windows) {
      if (firetray.Handler.windows[winId].visibility)
        firetray.Handler.hideSingleWindow(winId);
    }
  },

  showHideIcon: function() {
    if (firetray.Utils.prefService.getBoolPref('show_icon_on_hide'))
      firetray.Handler.setIconVisibility(
        (firetray.Handler.visibleWindowsCount !== firetray.Handler.windowsCount));
    else
      firetray.Handler.setIconVisibility(true);
  },

  /** nsIBaseWindow, nsIXULWindow, ... */
  getWindowInterface: function(win, iface) {
    let winInterface, winOut;
    try {                       // thx Neil Deakin !!
      winOut =  win.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebNavigation)
        .QueryInterface(Ci.nsIDocShellTreeItem)
        .treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor)[iface];
    } catch (ex) {
      // ignore no-interface exception
      ERROR(ex);
      return null;
    }

    return winOut;
  },

  _getBrowserProperties: function() {
    if (firetray.Handler.appId === FIREFOX_ID)
      return "chrome://branding/locale/browserconfig.properties";
    else if (firetray.Handler.appId === SEAMONKEY_ID)
      return "chrome://navigator-region/locale/region.properties";
    else return null;
  },

  _getHomePage: function() {
    var prefDomain = "browser.startup.homepage";
    var url;
    try {
      url = Services.prefs.getComplexValue(prefDomain,
        Components.interfaces.nsIPrefLocalizedString).data;
    } catch (e) {}

    // use this if we can't find the pref
    if (!url) {
      var SBS = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService);
      var configBundle = SBS.createBundle(firetray.Handler._getBrowserProperties());
      url = configBundle.GetStringFromName(prefDomain);
    }

    return url;
  },

  openBrowserWindow: function() {
    try {
      var home = firetray.Handler._getHomePage();
      LOG("home="+home);

      // FIXME: obviously we need to wait to avoid seg fault on jsapi.cpp:827
      // 827         if (t->data.requestDepth) {
      firetray.Utils.timer(function() {
        for(var key in firetray.Handler.windows) break;
        firetray.Handler.windows[key].chromeWin.open(home);
      }, FIRETRAY_DELAY_NOWAIT_MILLISECONDS, Ci.nsITimer.TYPE_ONE_SHOT);
    } catch (x) { ERROR(x); }
  },

  openMailMessage: function() {
    try {
      var aURI = Services.io.newURI("mailto:", null, null);
      var msgComposeService = Cc["@mozilla.org/messengercompose;1"]
        .getService(Ci.nsIMsgComposeService);
      msgComposeService.OpenComposeWindowWithURI(null, aURI);
    } catch (x) { ERROR(x); }
  },

  quitApplication: function() {
    try {
      firetray.Utils.timer(function() {
        let appStartup = Cc['@mozilla.org/toolkit/app-startup;1']
          .getService(Ci.nsIAppStartup);
        appStartup.quit(Ci.nsIAppStartup.eAttemptQuit);
      }, FIRETRAY_DELAY_NOWAIT_MILLISECONDS, Ci.nsITimer.TYPE_ONE_SHOT);
    } catch (x) { ERROR(x); }
  }

}; // firetray.Handler


firetray.PrefListener = new PrefListener(
  "extensions.firetray.",
  function(branch, name) {
    LOG('Pref changed: '+name);
    switch (name) {
    case 'hides_single_window':
      firetray.Handler.updatePopupMenu();
      break;
    case 'show_icon_on_hide':
      firetray.Handler.showHideIcon();
      break;
    default:
    }
  });