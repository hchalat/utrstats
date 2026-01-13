const fs = require('fs');
let content = fs.readFileSync('scraper-full.js', 'utf8');

// Replace all remaining page.$x patterns with clickByXPath
content = content.replace(
  /const showAllLinks = await page\.\$x\(\s*"\/\/\*\[contains\(text\(\), 'Show all'\)\]",?\s*\);?\s*if \(showAllLinks\.length > 0\) \{[^}]*const showAllLink = showAllLinks\[0\];[^}]*if \(isVisible\) \{[^}]*await showAllLink\.click\(\);[^}]*clickedShowAll = true;[^}]*console\.log\('   Clicked "Show all" link'\);[^}]*await delay\(5000\);[^}]*break;[^}]*\}[^}]*\}/gs,
  `const clicked = await clickByXPath(page, "//*[contains(text(), 'Show all')]");
          if (clicked) {
            clickedShowAll = true;
            console.log('   Clicked "Show all" link');
            await delay(5000);
            break;
          }`
);

// Replace other Show all patterns
content = content.replace(
  /const showAllElements = await page\.\$x\(\s*"\/\/\*\[contains\(text\(\), 'Show all'\)\]",?\s*\);?\s*if \(showAllElements\.length > 0\) \{[^}]*await showAllElements\[0\]\.click\(\);/gs,
  `const clicked = await clickByXPath(page, "//*[contains(text(), 'Show all')]");
          if (clicked) {`
);

// Replace Singles button
content = content.replace(
  /const singlesButtons = await page\.\$x\(\s*"\/\/button\[contains\(text\(\), 'Singles'\)\]",?\s*\);?\s*if \(singlesButtons\.length > 0\) \{[^}]*await singlesButtons\[0\]\.click\(\);[^}]*\}/gs,
  `await clickByXPath(page, "//button[contains(text(), 'Singles')]");`
);

// Replace Singles/Doubles with case-insensitive
content = content.replace(
  /const singlesButtons = await page\.\$x\(\s*"\/\/\*\[contains\(translate\(text\(\)[^\)]+\), 'singles'\)\]",?\s*\);?\s*if \(singlesButtons\.length > 0\) \{[^}]*await singlesButtons\[0\]\.click\(\);/gs,
  `await clickByXPath(page, "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'singles')]");`
);

content = content.replace(
  /const doublesButtons = await page\.\$x\(\s*"\/\/\*\[contains\(translate\(text\(\)[^\)]+\), 'doubles'\)\]",?\s*\);?\s*if \(doublesButtons\.length > 0\) \{[^}]*await doublesButtons\[0\]\.click\(\);/gs,
  `await clickByXPath(page, "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'doubles')]");`
);

fs.writeFileSync('scraper-full.js', content);
console.log('Fixed all $x calls');
