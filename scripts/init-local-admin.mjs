import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const config = 'data/admin.local.env';
const receipt = 'data/管理员密码.txt';

if (existsSync(config) || existsSync(receipt)) {
  console.error('本机管理员配置或凭据文件已存在，初始化已停止。');
  process.exit(1);
}
if (process.env.NF_ADMIN_PASSWORD_HASH || process.env.NF_SETTINGS_SECRET || process.env.NF_DB_PATH) {
  console.error('当前环境已有自定义后台配置，请使用原配置。');
  process.exit(1);
}
if (existsSync('data/novelflow.sqlite')) {
  const db = new DatabaseSync('data/novelflow.sqlite', { readOnly: true });
  const hasModels = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'models'").get();
  const hasEncryptedKeys = hasModels && db.prepare('SELECT 1 FROM models WHERE encrypted_key IS NOT NULL LIMIT 1').get();
  db.close();
  if (hasEncryptedKeys) {
    console.error('本机会话已有加密模型 Key，请沿用原加密主密钥。');
    process.exit(1);
  }
}

mkdirSync('data', { recursive: true, mode: 0o700 });
const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16);
const passwordHash = salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex');
const settingsSecret = randomBytes(32).toString('hex');
const options = { mode: 0o600, flag: 'wx' };
writeFileSync(receipt, password + '\n', options);
try {
  writeFileSync(config, [
    'NF_LOCAL_ADMIN_PASSWORD_ONLY=1',
    'NF_ADMIN_PASSWORD_HASH=' + passwordHash,
    'NF_SETTINGS_SECRET=' + settingsSecret,
    '',
  ].join('\n'), options);
} catch (error) {
  rmSync(receipt);
  throw error;
}
console.log('本机管理员已初始化，密码保存在 ' + receipt);
