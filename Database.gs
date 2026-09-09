/**
 * Database.gs
 * שכבת גישה יחידה ל-Google Sheets. שום קובץ אחר לא ניגש ל-SpreadsheetApp ישירות.
 * כל קריאה/כתיבה כאן היא Batch (getValues/setValues) - לא תא-אחר-תא.
 */

/** מחזיר את כל השורות של Tab כמערך אובייקטים, לפי שורת ה-Headers הראשונה */
function readSheet(sheetName) {
  var sheet = getDb().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return values.map(function (row) {
    var obj = { _row: null };
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  }).map(function (obj, idx) {
    obj._row = idx + 2; // מיקום פיזי בגיליון, לעדכון/מחיקה מהיר
    return obj;
  });
}

/** מוסיף שורה בודדת בסוף ה-Tab, לפי סדר ה-Headers הקיים */
function appendRow(sheetName, obj) {
  var sheet = getDb().getSheetByName(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

/** מוסיף מספר שורות בבת אחת - הרבה יותר מהיר מלולאת appendRow */
function appendRows(sheetName, objects) {
  if (!objects.length) return;
  var sheet = getDb().getSheetByName(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rows = objects.map(function (obj) {
    return headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/** מעדכן שורה קיימת (לפי מספר שורה פיזי _row) עם השדות שסופקו בלבד */
function updateRow(sheetName, rowNumber, partialObj) {
  var sheet = getDb().getSheetByName(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var currentValues = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var newValues = headers.map(function (h, i) {
    return partialObj.hasOwnProperty(h) ? partialObj[h] : currentValues[i];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([newValues]);
}

/** מוחק שורה פיזית מה-Tab */
function deleteRowPhysical(sheetName, rowNumber) {
  getDb().getSheetByName(sheetName).deleteRow(rowNumber);
}

/** מחפש שורה בודדת לפי ID, מחזיר null אם לא נמצאה */
function findById(sheetName, idField, idValue) {
  var rows = readSheet(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idField]) === String(idValue)) return rows[i];
  }
  return null;
}

/** קורא את כל ה-CONFIG כמפה key->value (מטיפוסים: number/boolean/string מזוהה אוטומטית) */
function readConfig() {
  var rows = readSheet(SHEET_NAMES.CONFIG);
  var config = {};
  rows.forEach(function (row) {
    var key = row.Key;
    var raw = row.Value;
    var val = raw;
    if (raw === 'TRUE' || raw === 'FALSE') val = (raw === 'TRUE');
    else if (!isNaN(raw) && raw !== '') val = Number(raw);
    config[key] = val;
  });
  return config;
}

/** מעדכן ערך CONFIG בודד (יוצר אם לא קיים) */
function writeConfigValue(key, value) {
  var sheet = getDb().getSheetByName(SHEET_NAMES.CONFIG);
  var rows = readSheet(SHEET_NAMES.CONFIG);
  var existing = rows.filter(function (r) { return r.Key === key; })[0];
  if (existing) {
    updateRow(SHEET_NAMES.CONFIG, existing._row, { Key: key, Value: value });
  } else {
    appendRow(SHEET_NAMES.CONFIG, { Key: key, Value: value });
  }
}
