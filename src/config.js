const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

function loadConfig() {
  const defaults = { port: 3000, api_key: '', batch_import_key: '', panel_password: '', grazie_agent: { name: 'aia:idea', version: '261.22158.366:261.22158.277' } };
  if (!fs.existsSync(CONFIG_PATH)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2)); } catch {}
    return defaults;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, '');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    try { fs.writeFileSync(CREDENTIALS_PATH, '[]'); } catch {}
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
}

function saveCredentials(credentials) {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

module.exports = { loadConfig, loadCredentials, saveCredentials, CONFIG_PATH, CREDENTIALS_PATH };
