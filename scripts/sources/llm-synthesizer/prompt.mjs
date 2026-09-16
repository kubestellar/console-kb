/**
 * Prompt construction and raw-input hygiene for the LLM synthesizer.
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */

import sanitizeHtml from 'sanitize-html'
import { truncate } from './parse.mjs'

// --- Prompt builder ---

export function buildPrompt(params) {
  const sections = [`# Project: ${params.projectName}\n# Issue: ${params.issueTitle}`]

  if (params.issueBody) {
    sections.push(`## Problem Description\n${truncate(cleanInput(params.issueBody), 3000)}`)
  }

  if (params.labels?.length) {
    sections.push(`## Labels\n${params.labels.join(', ')}`)
  }

  if (params.solution) {
    sections.push(`## Solution / Resolution\n${truncate(cleanInput(params.solution), 3000)}`)
  }

  if (params.codeSnippets?.length) {
    const cleanSnippets = params.codeSnippets.filter(s => !isGarbageSnippet(s)).slice(0, 5)
    if (cleanSnippets.length > 0) {
      sections.push(`## Relevant Code/Config\n${cleanSnippets.map(s => '```\n' + truncate(s, 800) + '\n```').join('\n')}`)
    }
  }

  if (params.prUrl) {
    sections.push(`## Linked PR: ${params.prUrl}`)
  }

  if (params.prDiff) {
    sections.push(`## Key Changes\n${truncate(cleanInput(params.prDiff), 2000)}`)
  }

  sections.push('\nSynthesize a high-quality mission from the above. Return a single JSON object.')
  return sections.join('\n\n')
}

// --- Input cleaning ---

export function cleanInput(text) {
  if (!text) return ''
  
  // First pass: remove specific unwanted sections
  let result = text
    .replace(/## \[?Codecov[\s\S]*?(?=\n## |\n---|\Z)/gi, '')
    .replace(/\|[^|]*coverage[^|]*\|[\s\S]*?\n\n/gi, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[image removed]')

  // Use sanitize-html to remove all HTML tags and comments (satisfies CodeQL taint tracking)
  result = sanitizeHtml(result, {
    allowedTags: [],
    allowedAttributes: {},
    allowedIframeHostnames: []
  })

  // Final cleanup
  return result
    .replace(/#{1,3}\s*(?:What this PR does|Release note|Changelog|Special notes)[\s\S]*?(?=\n#{1,3} |\n---|\Z)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function isGarbageSnippet(snippet) {
  const lower = snippet.toLowerCase()
  if (lower.includes('codecov') || lower.includes('coverage \u03b4') || lower.includes('impacted files')) return true
  if (snippet.startsWith('diff --git') || /^[+-]{3} [ab]\//.test(snippet)) return true
  if (lower.includes('invalid pr title') || lower.includes('has been automatically marked as stale')) return true
  if ((snippet.match(/!\[.*?\]\(https?:\/\//g) || []).length > 2) return true
  const lines = snippet.split('\n')
  const quotedLines = lines.filter(l => l.trim().startsWith('>')).length
  if (quotedLines > lines.length * 0.7 && lines.length > 3) return true
  return false
}
