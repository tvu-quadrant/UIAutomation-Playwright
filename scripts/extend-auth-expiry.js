const fs = require('fs');
const path = require('path');

(async () => {
  const authPath = path.resolve(__dirname, '..', 'MSAuth.json');
  if (!fs.existsSync(authPath)) {
    console.error('MSAuth.json not found at', authPath);
    process.exit(2);
  }

  const bak = authPath + '.bak.' + Date.now();
  fs.copyFileSync(authPath, bak);
  console.log('Backup created:', bak);

  const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (!data.cookies || !Array.isArray(data.cookies)) {
    console.error('No cookies array found in MSAuth.json');
    process.exit(3);
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const addSecs = 30 * 24 * 60 * 60; // 30 days
  const newExpiry = nowSecs + addSecs;

  data.cookies = data.cookies.map(c => {
    // Some cookies use 'expires' or 'expiry' naming; normalize
    if (typeof c.expires !== 'undefined') {
      c.expires = newExpiry;
    } else if (typeof c.expiry !== 'undefined') {
      c.expiry = newExpiry;
    } else {
      c.expires = newExpiry;
    }
    return c;
  });

  fs.writeFileSync(authPath, JSON.stringify(data, null, 2));
  console.log('Updated cookie expiries to', new Date(newExpiry * 1000).toISOString());
})();
