const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const filePath = path.resolve(process.argv[2] || 'src/components/ChatDashboard.jsx');
const code = fs.readFileSync(filePath, 'utf8');

try {
    parser.parse(code, {
        sourceType: 'module',
        plugins: ['jsx']
    });
    console.log('No syntax error found — file parses fine.');
} catch (err) {
    console.log('SYNTAX ERROR FOUND:');
    console.log('Line:', err.loc ? err.loc.line : '?', 'Column:', err.loc ? err.loc.column : '?');
    console.log('Message:', err.message);
    if (err.loc) {
        const lines = code.split('\n');
        const start = Math.max(0, err.loc.line - 15);
        const end = Math.min(lines.length, err.loc.line + 5);
        console.log('\n--- Context (line ' + (start + 1) + ' to ' + end + ') ---');
        for (let i = start; i < end; i++) {
            const marker = (i + 1 === err.loc.line) ? '>>' : '  ';
            console.log(marker + (i + 1) + ': ' + lines[i]);
        }
    }
}