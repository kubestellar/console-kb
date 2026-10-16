import { describe, it, expect } from 'vitest';
import { scoreMissionAdvanced } from '../advanced-quality-scorer.mjs';

describe('Advanced Quality Scorer', () => {
  it('should score a perfect mission correctly', () => {
    const perfectMission = {
      mission: {
        description: "This resolves the CrashLoopBackOff error by configuring the right memory overhead limit for the caching instance.",
        steps: [
          {
            title: "Check current limit",
            description: "Run ```kubectl get pods -n kube-system``` and verify the memory error in logs: ```kubectl logs pod-name```"
          },
          {
            title: "Apply new configuration",
            description: "Apply the updated manifest:\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: coredns\n```"
          },
          {
            title: "Verify deployment success",
            description: "Ensure the new pods are running successfully:\n```kubectl get pods -n kube-system -w```"
          }
        ],
        resolution: {
          summary: "By adjusting the memory limits, we ensure the pod has enough overhead to process large cache spikes, resolving the OOM issue permanently.",
          codeSnippets: ["kubectl apply -f memory-fix.yaml"]
        }
      },
      metadata: {
        tags: ["coredns", "startup", "oom"],
        difficulty: "intermediate",
        cncfProjects: ["coredns"]
      }
    };

    const result = scoreMissionAdvanced(perfectMission, 'coredns', 'test.json');
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.issues).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('should penalize a poor quality mission and provide issues', () => {
    const poorMission = {
      mission: {
        description: "fix bug",
        steps: [
          {
            title: "understand",
            description: "Understand the issue."
          }
        ],
        resolution: {
          summary: "fixed"
        }
      },
      metadata: {}
    };

    const result = scoreMissionAdvanced(poorMission, 'unknown', 'test.json');
    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(60);
    
    // Check specific identified issues
    expect(result.issues).toContain("Description is too brief or ambiguous");
    expect(result.issues).toContain("No verification step or command found"); // Should trigger observability penalty
    expect(result.issues).toContain("Instruction logic missing required configuration fragments or commands");
  });
});
