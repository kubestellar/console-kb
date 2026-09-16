/**
 * Project metadata helpers for the CNCF mission generator.
 *
 * Extracted from generate-cncf-missions.mjs (console-kb#3133 / #3332) so the
 * Kubernetes-native classification and per-project CLI mapping can be
 * unit-tested independently of the GitHub scraping and mission-synthesis
 * concerns that remain in the main script.
 */

/**
 * Check if a project is Kubernetes-native (runs on or extends K8s).
 * Non-K8s projects (databases, web servers, etc.) should not get K8s prerequisites.
 */
export const K8S_NATIVE_CATEGORIES = new Set([
  'orchestration', 'networking', 'security', 'observability',
  'runtime', 'storage', 'app-definition', 'ai-agents', 'llm-serving',
])

export const NON_K8S_PROJECTS = new Set([
  // Databases and data stores — standalone servers, not K8s operators
  'clickhouse', 'surrealdb', 'valkey', 'milvus', 'tikv', 'vitess',
  // Web servers and reverse proxies
  'caddy',
  // Self-hosted platforms — can run on K8s but have their own CLI/admin UI
  'gitea', 'vault', 'keycloak', 'harbor', 'backstage', 'dify',
  // Monitoring/observability — standalone installs
  'netdata',
  // AI/ML tools — pip-installed, not K8s workloads
  'ollama', 'langflow', 'vllm',
  // Libraries and frameworks — no runtime binary, used via language package managers
  'grpc', 'connect-rpc', 'cloudevents', 'in-toto',
  'the-update-framework-tuf-', 'kube-rs', 'client-go',
  // CLI tools — run locally, not deployed as K8s workloads
  'buildpacks', 'ko', 'helm', 'kpt', 'opentofu', 'oras',
  'notation', 'sops', 'slimtoolkit', 'score',
  'podman-container-tools', 'lima',
  // Container/wasm runtimes — low-level, not K8s workloads
  'spin', 'wasmedge-runtime', 'container2wasm',
  // IDE extensions and desktop tools
  'visual-studio-code-kubernetes-tools',
  // Policy language — library/CLI, not a K8s workload
  'cedar',
  // Specifications and community projects — no installable component
  'opentelemetry-community', 'openssf', 'openmetrics', 'cloudevents-spec',
])

export function isKubernetesNative(project) {
  if (NON_K8S_PROJECTS.has(project.name)) return false
  if (project.category && K8S_NATIVE_CATEGORIES.has(project.category)) return true
  // Projects with k8sVersions field are K8s-related
  if (project.k8sVersions && project.k8sVersions.length > 0) return true
  return true // default to true for CNCF projects
}

/**
 * Project-specific CLI commands for version checks and status checks.
 * Entries with `null` for versionCmd mean the project has no CLI binary
 * (it's a library or framework used via a package manager).
 */
export const PROJECT_CLI_MAP = {
  // Databases and data stores
  clickhouse: { versionCmd: 'clickhouse-client --version', statusCmd: 'clickhouse-client -q "SELECT version()"', tools: ['clickhouse-client'] },
  surrealdb: { versionCmd: 'surreal version', statusCmd: 'surreal is-ready', tools: ['surreal'] },
  valkey: { versionCmd: 'valkey-server --version', statusCmd: 'valkey-cli ping', tools: ['valkey-server', 'valkey-cli'] },
  milvus: { versionCmd: 'pip show pymilvus | grep Version', statusCmd: null, tools: ['python', 'pip'], ecosystem: 'python' },
  tikv: { versionCmd: 'tikv-server --version', statusCmd: null, tools: ['tikv-server'] },
  vitess: { versionCmd: 'vtctldclient --version', statusCmd: null, tools: ['vtctldclient'] },
  // Web servers
  caddy: { versionCmd: 'caddy version', statusCmd: 'caddy validate --config /etc/caddy/Caddyfile', tools: ['caddy'] },
  // Self-hosted platforms
  gitea: { versionCmd: 'gitea --version', statusCmd: null, tools: ['docker', 'git'] },
  vault: { versionCmd: 'vault version', statusCmd: 'vault status', tools: ['vault'] },
  keycloak: { versionCmd: 'kc.sh --version 2>/dev/null || bin/kc.sh --version', statusCmd: null, tools: ['java'], ecosystem: 'java' },
  harbor: { versionCmd: null, statusCmd: 'curl -s http://localhost/api/v2.0/health | jq .status', tools: ['docker-compose', 'curl'] },
  backstage: { versionCmd: 'npx backstage-cli info', statusCmd: null, tools: ['node', 'npm'], ecosystem: 'node' },
  dify: { versionCmd: 'docker compose version', statusCmd: 'docker compose ps', tools: ['docker', 'docker-compose'] },
  // Monitoring
  netdata: { versionCmd: 'netdata -v', statusCmd: 'curl -s http://localhost:19999/api/v1/info | jq .version', tools: ['netdata'] },
  // AI/ML
  ollama: { versionCmd: 'ollama --version', statusCmd: 'ollama list', tools: ['ollama'] },
  langflow: { versionCmd: 'langflow --version', statusCmd: null, tools: ['python', 'pip'], ecosystem: 'python' },
  vllm: { versionCmd: 'pip show vllm | grep Version', statusCmd: 'python -c "import vllm; print(vllm.__version__)"', tools: ['python', 'pip'], ecosystem: 'python' },
  // Libraries — no CLI binary
  grpc: { versionCmd: null, statusCmd: null, tools: ['protoc'], ecosystem: 'multi', description: 'gRPC library — check your language-specific package (e.g., pip show grpcio, npm ls @grpc/grpc-js)' },
  'connect-rpc': { versionCmd: null, statusCmd: null, tools: ['buf'], ecosystem: 'multi', description: 'Connect-RPC library — check your language-specific package' },
  cloudevents: { versionCmd: null, statusCmd: null, tools: [], ecosystem: 'multi', description: 'CloudEvents is a specification — check your SDK version (e.g., pip show cloudevents)' },
  'in-toto': { versionCmd: 'pip show in-toto | grep Version', statusCmd: null, tools: ['python', 'pip'], ecosystem: 'python' },
  'the-update-framework-tuf-': { versionCmd: 'pip show tuf | grep Version', statusCmd: null, tools: ['python', 'pip'], ecosystem: 'python' },
  'kube-rs': { versionCmd: null, statusCmd: null, tools: ['rustc', 'cargo'], ecosystem: 'rust', description: 'kube-rs is a Rust library — check Cargo.toml for the version' },
  // CLI tools
  buildpacks: { versionCmd: 'pack version', statusCmd: 'pack builder suggest', tools: ['pack'] },
  ko: { versionCmd: 'ko version', statusCmd: null, tools: ['ko', 'go'] },
  helm: { versionCmd: 'helm version --short', statusCmd: 'helm repo list', tools: ['helm'] },
  kpt: { versionCmd: 'kpt version', statusCmd: null, tools: ['kpt'] },
  opentofu: { versionCmd: 'tofu version', statusCmd: null, tools: ['tofu'] },
  oras: { versionCmd: 'oras version', statusCmd: null, tools: ['oras'] },
  notation: { versionCmd: 'notation version', statusCmd: null, tools: ['notation'] },
  'notary-project': { versionCmd: 'notation version', statusCmd: null, tools: ['notation'] },
  sops: { versionCmd: 'sops --version', statusCmd: null, tools: ['sops'] },
  slimtoolkit: { versionCmd: 'slim version', statusCmd: null, tools: ['slim'] },
  score: { versionCmd: 'score-compose version', statusCmd: null, tools: ['score-compose'] },
  'podman-container-tools': { versionCmd: 'podman --version', statusCmd: 'podman info --format json | jq .version', tools: ['podman'] },
  lima: { versionCmd: 'limactl --version', statusCmd: 'limactl list', tools: ['limactl'] },
  // Container/wasm runtimes
  spin: { versionCmd: 'spin --version', statusCmd: null, tools: ['spin'] },
  'wasmedge-runtime': { versionCmd: 'wasmedge --version', statusCmd: null, tools: ['wasmedge'] },
  container2wasm: { versionCmd: null, statusCmd: null, tools: ['docker'], ecosystem: 'go' },
  cedar: { versionCmd: 'cedar --version 2>/dev/null || cargo install --list | grep cedar', statusCmd: null, tools: ['cedar'], ecosystem: 'rust' },
}

/**
 * Get the CLI version-check command for a project.
 * Returns the specific command if mapped, or null for libraries with no CLI.
 */
export function getProjectVersionCmd(project) {
  const mapped = PROJECT_CLI_MAP[project.name]
  if (mapped) return mapped.versionCmd
  return `${project.name} version`
}

/**
 * Get the CLI status-check command for a project.
 * Returns the specific command if mapped, or null if not applicable.
 */
export function getProjectStatusCmd(project) {
  const mapped = PROJECT_CLI_MAP[project.name]
  if (mapped) return mapped.statusCmd
  return `${project.name} status 2>&1 | head -20`
}

/**
 * Generate project-aware prerequisites instead of hardcoding K8s.
 */
export function generatePrerequisites(project) {
  if (isKubernetesNative(project)) {
    return {
      kubernetes: '>=1.24',
      tools: ['kubectl'],
      description: `A running Kubernetes cluster with ${project.name} installed or the issue environment reproducible.`,
    }
  }

  // Check project-specific CLI mapping first
  const mapped = PROJECT_CLI_MAP[project.name]
  if (mapped) {
    return {
      tools: mapped.tools.length > 0 ? mapped.tools : [project.name],
      description: mapped.description || `A working ${project.name} installation or development environment.`,
    }
  }

  // Fallback for unmapped non-K8s projects
  return {
    tools: [project.name],
    description: `A working ${project.name} installation or development environment.`,
  }
}
