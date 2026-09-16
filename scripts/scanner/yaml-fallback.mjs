/**
 * Minimal fallback YAML parser used when a mission file fails JSON.parse.
 * Extracted from scripts/scanner.mjs (console-kb#3195).
 */

/**
 * Minimal YAML-like parser for simple key-value documents.
 * For full YAML support, use the js-yaml package in the entry-point scripts.
 */
export function tryParseYamlSimple(content) {
  // Only handle if it looks like YAML (has colons, no opening brace)
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) return null;
  if (!content.includes(':')) return null;

  try {
    // Try to import and use js-yaml if available
    // Dynamic import is async, so this is a best-effort sync approach
    // For production use, the caller should handle YAML parsing
    const lines = content.split('\n');
    const result = {};
    let currentKey = null;
    let currentValue = '';
    let indent = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        // Save previous key-value if exists
        if (currentKey !== null) {
          result[currentKey] = currentValue.trim() || null;
        }
        
        currentKey = trimmed.substring(0, colonIndex).trim();
        const afterColon = trimmed.substring(colonIndex + 1).trim();
        
        if (afterColon) {
          // Inline value
          currentValue = afterColon;
        } else {
          // Multi-line value
          currentValue = '';
        }
      } else if (currentKey !== null && line.startsWith('  ')) {
        // Continuation of multi-line value
        currentValue += (currentValue ? '\n' : '') + trimmed;
      }
    }
    
    // Save last key-value
    if (currentKey !== null) {
      result[currentKey] = currentValue.trim() || null;
    }
    
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
