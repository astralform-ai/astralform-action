# Astralform Agent — GitHub Action

Mention your [Astralform](https://astralform.ai) agent on an issue or pull request and it does the work.

**There is nothing to configure and no secret to store.** The workflow proves which repository it is
with a GitHub-signed OIDC token, and Astralform mints repository access per run, scoped to that one
repository, and discards it when the run ends.

## Quick start

Connect GitHub on your agent's **Connectors** page in the dashboard, then commit this as
`.github/workflows/astralform.yml` in each repository the agent should answer in:

```yaml
name: Astralform

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]
  pull_request:
    types: [opened]

jobs:
  astralform:
    # Only run when the agent is actually mentioned — otherwise every issue and
    # comment spends a runner minute finding out it was not for us.
    if: >-
      github.event.sender.type != 'Bot' &&
      contains(github.event.comment.body || github.event.issue.body ||
               github.event.pull_request.body, '@astralform-agent')
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: astralform-ai/astralform-action@v1
        with:
          agent: your-agent-name
```

`agent` is the agent's **name** as it appears in the dashboard. The dashboard's connector page
generates this file with the name already filled in — copy it from there.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `agent` | yes | — | Which agent answers. Resolved by name, scoped to the GitHub account that owns this repository. |
| `instruction` | no | the triggering body | What to ask. Defaults to the comment, issue, or pull request body that fired the event. |
| `issue-number` | no | the triggering number | The issue or PR the run is about. |
| `api-url` | no | `https://api.astralform.ai` | Only for a self-hosted deployment. |
| `audience` | no | `https://api.astralform.ai` | OIDC audience. Must match what the deployment pins. Change only alongside `api-url`. |

## Outputs

| Output | What it is |
|---|---|
| `status` | Dispatch result reported by Astralform. |
| `agent` | The agent that picked the run up. |
| `repository` | The repository Astralform resolved from the OIDC token. |
| `issue-number` | The issue or pull request the run is about. |

## Permissions

```yaml
permissions:
  id-token: write   # required — mints the OIDC token that proves the repository
  contents: read
```

Without `id-token: write` the action fails immediately and says so. That is the single most common
setup mistake, so it is checked before anything is sent.

## Who can start a run

The OIDC token proves which **repository** is calling. It says nothing about **who** commented — so
Astralform gates separately on the author's association with the repository, and only an `OWNER`,
`MEMBER` or `COLLABORATOR` may start a run. A drive-by comment from a stranger mentioning the agent
is refused server-side, whatever the workflow does.

That check is made against the repository by Astralform. This action reports the association; it
does not assert it.

## Why an action instead of pasting curl

The previous setup was ~45 lines of `curl` and `jq` pasted into every repository. Three things get
better here:

- **It versions.** Pin `@v1` and dispatch-contract changes ship to you; the pasted snippet froze on
  the day it was copied.
- **Failures say what happened.** A refused dispatch surfaces the reason — a name that does not
  resolve, an untrusted author, a missing permission — instead of a non-zero curl.
- **It closes a script-injection hole.** Issue bodies are attacker-controlled. Splicing one into a
  `run:` block with `${{ }}` executes it on the runner. Every value here crosses into the script
  through the environment, which cannot be escaped out of.

## Versioning and pinning

`@v1` is a **moving** major tag: it follows every backwards-compatible release. That convenience is
also a trust decision — this action runs on your runner with `id-token: write`, so whoever can move
`v1` can change what executes there. Three options, in increasing strictness:

| Pin | What you get |
|---|---|
| `@v1` | Fixes and features arrive automatically. The tag moves. |
| `@v1.0.1` | **Immutable.** A repository ruleset blocks deletion, update and force-push on every `v*.*.*` tag, so a released version can never be re-pointed. |
| `@<full-sha>` | Immutable and independent of our tagging entirely. Dependabot and Renovate both keep SHA pins current. |

If your organisation already pins `actions/checkout@<sha>`, pin this the same way — there is nothing
special about it being first-party.

## License

MIT — see [LICENSE](LICENSE).
