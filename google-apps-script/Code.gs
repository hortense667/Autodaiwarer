/**
 * AutoDaiwarer sync backend for Google Apps Script.
 *
 * Web app endpoint:
 * - GET  ?share=<id>             -> { ok, share, version, text, updatedAt, updatedBy }
 * - POST body(JSON string)       -> { ok, share, version, conflict?, text? }
 *
 * Request JSON for POST:
 * {
 *   "share": "book-202605",
 *   "text": "<full source text>",
 *   "baseVersion": 12,
 *   "clientId": "client-xxx",
 *   "locale": "ja"
 * }
 */

var SYNC_FOLDER_NAME = "autodaiwarer-sync";
var FILE_EXT = ".json";
var BUG_REPORT_FOLDER_NAME = "autodaiwarer-bug-reports";
var BUG_REPORT_SPREADSHEET_NAME = "autodaiwarer_bug_reports";
var BUG_REPORT_SHEET_NAME = "reports";
var BUG_REPORT_MAX_MESSAGE_LENGTH = 2000;
var BUG_REPORT_MIN_INTERVAL_SEC = 20;
var BUG_REPORT_DUPLICATE_WINDOW_SEC = 10 * 60;
var BUG_REPORT_HOURLY_LIMIT_PER_CLIENT = 5;

function doGet(e) {
  try {
    var share = normalizeShareId(getParam_(e, "share"));
    if (!share) return json_({ ok: false, error: "share is required" });

    var record = readRecordByShare_(share);
    if (!record) {
      return json_({
        ok: true,
        share: share,
        version: 0,
        text: "",
        updatedAt: "",
        updatedBy: "",
      });
    }

    return json_({
      ok: true,
      share: share,
      version: numberOrZero_(record.version),
      text: String(record.text || ""),
      updatedAt: String(record.updatedAt || ""),
      updatedBy: String(record.updatedBy || ""),
    });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = parseJsonBody_(e);
    if (isBugReportPayload_(body)) {
      return handleBugReportPost_(body);
    }
    var share = normalizeShareId(body.share);
    var nextText = String(body.text || "");
    var baseVersion = numberOrZero_(body.baseVersion);
    var clientId = String(body.clientId || "");
    var locale = String(body.locale || "");

    if (!share) return json_({ ok: false, error: "share is required" });
    if (!nextText) return json_({ ok: false, error: "text is required" });

    var current = readRecordByShare_(share);
    var currentVersion = current ? numberOrZero_(current.version) : 0;

    if (baseVersion < currentVersion) {
      return json_({
        ok: true,
        share: share,
        conflict: true,
        version: currentVersion,
        text: String(current.text || ""),
        updatedAt: String(current.updatedAt || ""),
        updatedBy: String(current.updatedBy || ""),
      });
    }

    var nowIso = new Date().toISOString();
    var updatedBy = buildUpdatedBy_(clientId, locale);
    var saved = {
      share: share,
      version: currentVersion + 1,
      text: nextText,
      updatedAt: nowIso,
      updatedBy: updatedBy,
    };
    writeRecordByShare_(share, saved);

    return json_({
      ok: true,
      share: share,
      version: saved.version,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
    });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function buildUpdatedBy_(clientId, locale) {
  var email = "";
  try {
    email = Session.getActiveUser().getEmail() || "";
  } catch (_ignore) {}
  var parts = [];
  if (email) parts.push(email);
  if (clientId) parts.push(clientId);
  if (locale) parts.push(locale);
  return parts.join(" | ");
}

function parseJsonBody_(e) {
  var raw = "";
  if (e && e.postData && typeof e.postData.contents === "string") {
    raw = e.postData.contents;
  }
  if (!raw) return {};
  return JSON.parse(raw);
}

function isBugReportPayload_(body) {
  if (!body || typeof body !== "object") return false;
  var type = String(body.type || body.kind || "").trim().toLowerCase();
  return type === "bugreport" || type === "bug-report";
}

function handleBugReportPost_(body) {
  var email = normalizeBugReportEmail_(body.email);
  var message = normalizeBugReportMessage_(body.message);
  var locale = normalizeTinyText_(body.locale, 16);
  var clientId = normalizeTinyText_(body.clientId, 80);
  var appVersion = normalizeTinyText_(body.appVersion, 80);
  var pageUrl = normalizeTinyText_(body.pageUrl, 1000);
  var userAgent = normalizeTinyText_(body.userAgent, 300);
  if (!message) return json_({ ok: false, error: "message is required" });
  if (message.length > BUG_REPORT_MAX_MESSAGE_LENGTH) {
    return json_({ ok: false, error: "message must be 2000 characters or fewer" });
  }
  if (email && !isValidEmail_(email)) {
    return json_({ ok: false, error: "email format is invalid" });
  }

  var normalizedMessage = normalizeForDuplicate_(message);
  var messageHash = sha256Hex_(normalizedMessage);
  var requesterKey = buildRateLimitRequesterKey_(email, clientId);
  var rateError = enforceBugReportRateLimit_(requesterKey, messageHash);
  if (rateError) return json_({ ok: false, error: rateError });

  var now = new Date();
  var reportId = Utilities.formatDate(now, "UTC", "yyyyMMddHHmmss") + "-" + randomToken_(8);
  var row = [
    reportId,
    now.toISOString(),
    email,
    message,
    locale,
    clientId,
    appVersion,
    pageUrl,
    userAgent,
    messageHash,
  ];
  appendBugReportRow_(row);

  return json_({ ok: true, id: reportId });
}

function normalizeBugReportEmail_(value) {
  return normalizeTinyText_(value, 320).toLowerCase();
}

function normalizeBugReportMessage_(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function normalizeTinyText_(value, maxLen) {
  var s = String(value || "").trim();
  if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeForDuplicate_(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildRateLimitRequesterKey_(email, clientId) {
  if (email) return "mail:" + email;
  if (clientId) return "client:" + clientId;
  return "anonymous";
}

function enforceBugReportRateLimit_(requesterKey, messageHash) {
  var cache = CacheService.getScriptCache();
  var requesterHash = sha256Hex_(requesterKey);

  var cooldownKey = "br:cooldown:" + requesterHash;
  if (cache.get(cooldownKey)) {
    return "Please wait a moment before sending another report";
  }
  cache.put(cooldownKey, "1", BUG_REPORT_MIN_INTERVAL_SEC);

  var duplicateKey = "br:dup:" + messageHash;
  if (cache.get(duplicateKey)) {
    return "A very similar message was submitted recently";
  }
  cache.put(duplicateKey, "1", BUG_REPORT_DUPLICATE_WINDOW_SEC);

  var props = PropertiesService.getScriptProperties();
  var hourBucket = Utilities.formatDate(new Date(), "UTC", "yyyyMMddHH");
  var countKey = "BUG_REPORT_HOUR_" + hourBucket + "_" + requesterHash;
  var current = Number(props.getProperty(countKey) || "0");
  if (!isFinite(current)) current = 0;
  if (current >= BUG_REPORT_HOURLY_LIMIT_PER_CLIENT) {
    return "Too many reports in a short period. Please try again later";
  }
  props.setProperty(countKey, String(current + 1));
  return "";
}

function appendBugReportRow_(row) {
  var sheet = getBugReportSheet_();
  var safe = [];
  for (var i = 0; i < row.length; i += 1) {
    safe.push(sanitizeForSheetCell_(row[i]));
  }
  sheet.appendRow(safe);
}

function getBugReportSheet_() {
  var props = PropertiesService.getScriptProperties();
  var savedId = String(props.getProperty("BUG_REPORT_SPREADSHEET_ID") || "");
  var ss = null;
  if (savedId) {
    try {
      ss = SpreadsheetApp.openById(savedId);
    } catch (_ignore) {}
  }
  if (!ss) {
    ss = SpreadsheetApp.create(BUG_REPORT_SPREADSHEET_NAME);
    props.setProperty("BUG_REPORT_SPREADSHEET_ID", ss.getId());
    try {
      var folder = getBugReportFolder_();
      var file = DriveApp.getFileById(ss.getId());
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    } catch (_ignore2) {}
  }

  var sheet = ss.getSheetByName(BUG_REPORT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(BUG_REPORT_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "id",
      "createdAt",
      "email",
      "message",
      "locale",
      "clientId",
      "appVersion",
      "pageUrl",
      "userAgent",
      "messageHash",
    ]);
  }
  return sheet;
}

function getBugReportFolder_() {
  var props = PropertiesService.getScriptProperties();
  var savedFolderId = String(props.getProperty("BUG_REPORT_FOLDER_ID") || "");
  if (savedFolderId) {
    try {
      return DriveApp.getFolderById(savedFolderId);
    } catch (_ignore) {}
  }

  var iter = DriveApp.getFoldersByName(BUG_REPORT_FOLDER_NAME);
  var folder = iter.hasNext() ? iter.next() : DriveApp.createFolder(BUG_REPORT_FOLDER_NAME);
  props.setProperty("BUG_REPORT_FOLDER_ID", folder.getId());
  return folder;
}

function sanitizeForSheetCell_(value) {
  var text = String(value == null ? "" : value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function sha256Hex_(text) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ""),
    Utilities.Charset.UTF_8
  );
  var out = [];
  for (var i = 0; i < digest.length; i += 1) {
    var v = digest[i];
    if (v < 0) v += 256;
    var hex = v.toString(16);
    out.push(hex.length === 1 ? "0" + hex : hex);
  }
  return out.join("");
}

function randomToken_(len) {
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  var out = "";
  for (var i = 0; i < len; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function getParam_(e, key) {
  if (!e || !e.parameter) return "";
  return String(e.parameter[key] || "");
}

function normalizeShareId(value) {
  var v = String(value || "").trim();
  if (!v) return "";
  v = v.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (v.length > 80) v = v.slice(0, 80);
  return v;
}

function numberOrZero_(value) {
  var n = Number(value);
  return isFinite(n) ? n : 0;
}

function getSyncFolder_() {
  var props = PropertiesService.getScriptProperties();
  var savedFolderId = String(props.getProperty("SYNC_FOLDER_ID") || "");
  if (savedFolderId) {
    try {
      return DriveApp.getFolderById(savedFolderId);
    } catch (_ignore) {}
  }

  var iter = DriveApp.getFoldersByName(SYNC_FOLDER_NAME);
  var folder = iter.hasNext() ? iter.next() : DriveApp.createFolder(SYNC_FOLDER_NAME);
  props.setProperty("SYNC_FOLDER_ID", folder.getId());
  return folder;
}

function getFileNameByShare_(share) {
  return share + FILE_EXT;
}

function readRecordByShare_(share) {
  var folder = getSyncFolder_();
  var fileName = getFileNameByShare_(share);
  var files = folder.getFilesByName(fileName);
  if (!files.hasNext()) return null;
  var file = files.next();
  var raw = file.getBlob().getDataAsString("UTF-8");
  if (!raw) return null;
  return JSON.parse(raw);
}

function writeRecordByShare_(share, record) {
  var folder = getSyncFolder_();
  var fileName = getFileNameByShare_(share);
  var files = folder.getFilesByName(fileName);
  var body = JSON.stringify(record);
  if (files.hasNext()) {
    var file = files.next();
    file.setContent(body);
    return;
  }
  folder.createFile(fileName, body, MimeType.PLAIN_TEXT);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
