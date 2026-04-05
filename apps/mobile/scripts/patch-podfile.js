#!/usr/bin/env node
// Removes :privacy_file_aggregation_enabled from the generated Podfile.
// This keyword was introduced in CocoaPods 1.15+ but EAS build servers run 1.14.3.
const fs = require('fs');
const path = require('path');

const podfilePath = path.join(__dirname, '..', 'ios', 'Podfile');
const content = fs.readFileSync(podfilePath, 'utf8');
const patched = content.replace(/[ \t]*:privacy_file_aggregation_enabled\s*=>[^,\n]+,?\n?/g, '');
fs.writeFileSync(podfilePath, patched);
console.log('patch-podfile: removed :privacy_file_aggregation_enabled');
