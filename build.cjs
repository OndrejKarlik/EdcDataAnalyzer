const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Ensure the dist/ folder exists
const distPath = path.resolve(__dirname, 'dist');
if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath);
}

// Copy HTML file manually (ESBuild doesn't process HTML)
fs.copyFileSync('EdcReportAnalyzer.html', 'dist/index.html');

esbuild.build({
    entryPoints: ['EdcReportAnalyzer.js'],
    bundle: true,
    outfile: 'dist/EdcReportAnalyzer.js',
    minify: true,
    sourcemap: true,
    loader: { '.css': 'css' }, // Enable CSS loading
    // watch: process.argv.includes('--watch'), // Enable watch mode
}).then(() => console.log("✅ Build Complete!"));