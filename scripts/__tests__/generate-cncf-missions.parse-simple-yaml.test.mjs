import { describe, it, expect } from 'vitest'
import { loadSourcesConfig } from '../generate-cncf-missions.mjs'

// Keep the historical parser test suite's contract: migrating to yaml must
// preserve every setting in the checked-in knowledge source configuration.
describe('knowledge-sources.yaml migration compatibility', () => {
  it('preserves every checked-in source value and type from the previous parser', () => {
    expect(loadSourcesConfig()).toStrictEqual({
      sources: {
        'github-issues': {
          enabled: true,
          description: 'Closed GitHub issues with linked PRs (high engagement)',
          minReactions: 10,
          minComments: 10,
          maxPerProject: 20,
          searchWindow: '90d',
          rateLimitDelay: 200,
        },
        'github-discussions': {
          enabled: true,
          description: 'Answered GitHub Discussions (Q&A format)',
          minUpvotes: 5,
          maxPerProject: 10,
          searchWindow: '90d',
          rateLimitDelay: 200,
        },
        reddit: {
          enabled: true,
          description: 'Reddit posts from kubernetes/cloud-native subreddits',
          subreddits: ['kubernetes', 'devops', 'k8s', 'cloudnative'],
          minUpvotes: 20,
          maxPerProject: 10,
          searchWindow: '180d',
          rateLimitDelay: 2000,
        },
        stackoverflow: {
          enabled: true,
          description: 'Stack Overflow Q&A with accepted answers',
          minVotes: 10,
          maxPerProject: 10,
          searchWindow: '365d',
          rateLimitDelay: 1000,
        },
        'cncf-blog': {
          enabled: false,
          description: 'CNCF blog posts and case studies',
          maxPerProject: 5,
          searchWindow: '365d',
        },
      },
    })
  })
})
