import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 12 || password.length > 256) {
  console.error('请输入 12–256 个字符的管理员密码。');
  process.exitCode = 1;
} else {
  const salt = randomBytes(16);
  console.log(salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex'));
}
