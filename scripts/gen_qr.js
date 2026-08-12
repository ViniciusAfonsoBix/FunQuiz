const QR = require('../public/qr.js');
const fs = require('fs');
const url = 'https://funquiz-sgn7.onrender.com/play';
const svg = QR.svg(url, { dark: '#14082b', light: '#ffffff', quiet: 2 });
fs.writeFileSync('public/test-qr.svg', svg);
console.log('WROTE public/test-qr.svg');
