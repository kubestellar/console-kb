import { readFileSync } from 'fs';
import { scoreMissionAdvanced, MIN_SCORE } from './advanced-quality-scorer.mjs';

function main() {
  const files = process.argv.slice(2);
  
  if (files.length === 0) {
    console.log('No KB JSON files provided for scoring.');
    process.exit(0);
  }

  console.log(`Evaluating ${files.length} KB entries for quality...\n`);
  
  let failed = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const data = JSON.parse(content);
      
      const project = data.metadata?.cncfProjects?.[0] || 'Unknown';
      const result = scoreMissionAdvanced(data, project, file, MIN_SCORE);
      
      console.log(`=================================================`);
      console.log(`File: ${file}`);
      console.log(`Project: ${result.project}`);
      console.log(`Score: ${result.score}/100 (${result.pass ? '[PASS] OK' : '[FAIL] BELOW THRESHOLD'})`);
      console.log(`Breakdown:`);
      Object.entries(result.breakdown).forEach(([k, v]) => {
        console.log(`  - ${k}: ${v}`);
      });
      
      if (result.issues.length > 0) {
        console.log(`\nIssues Found:`);
        result.issues.forEach(i => console.log(`  [!] ${i}`));
      }
      
      if (result.suggestions.length > 0) {
        console.log(`\nSuggestions:`);
        result.suggestions.forEach(s => console.log(`  [*] ${s}`));
      }

      console.log(`=================================================\n`);

      if (!result.pass) {
        failed++;
      }
    } catch (e) {
      console.error(`Error evaluating ${file}: ${e.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\nValidation Failed: ${failed} KB entries fell below the minimum quality threshold of ${MIN_SCORE}.`);
    process.exit(1);
  } else {
    console.log(`\nSuccess: All ${files.length} KB entries met the minimum quality standards.`);
    process.exit(0);
  }
}

main();
