# Phase 5 builds on GitHub Actions

AgencyOS does not run a toolchain. An Admin presses **Run the build** on a development build: AgencyOS records a **build request** (the exact commit, a state),
asks the governed git writer to start a workflow run on that commit, and records the run's **signed report** through the same doors and decisions as any build (a
"success" with a failed required stage or no artifact is still a failure; a smoke result is recorded honestly, `not tested` when the run did not launch the artifact).

## What you provide (the owner)

AgencyOS already has a governed GitHub writer (`git.build_triggered`, audited, and the only code that writes to GitHub). The build uses it, so there are only three things:

| What | Where |
|---|---|
| The repository linked to the project, with its **workflow file** (for example `agencyos-build.yml`) | The project's **Repository** tab (existing "Trigger build" setting). The token is the existing `GITHUB_TOKEN`, which must be allowed to dispatch workflows (Actions: read and write). |
| `BUILD_REPORT_SECRET`: a long random string | The AgencyOS deployment environment, AND the repository secret `AGENCYOS_REPORT_SECRET` in that GitHub repository. |
| `NEXT_PUBLIC_APP_URL` | Already set; the report endpoint is `${NEXT_PUBLIC_APP_URL}/api/builds/report`. |

Until a workflow file is linked and `BUILD_REPORT_SECRET` is set, **Run the build** records an honest `environment_missing` blocker and says what is missing.

## The workflow (`.github/workflows/agencyos-build.yml` in that repository)

```yaml
name: agencyos-build
on:
  workflow_dispatch:
    inputs:
      commit: { description: Exact commit to build, required: true }
      request_id: { required: true }
      deliverable_id: { required: true }
      environment: { required: true }
      report_url: { required: true }
permissions: { contents: read }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.commit }} }
      - id: run
        shell: bash
        run: |
          set +e
          stages='[]'
          add() { stages=$(jq -c --arg n "$1" --arg s "$2" '. + [{name:$n,status:$s}]' <<<"$stages"); }
          add source passed
          add env passed
          npm ci && add install passed || { add install failed; ok=0; }
          if [ -z "$ok" ]; then npm run lint && npm run typecheck && add lint_type passed || { add lint_type failed; ok=0; }; fi
          if [ -z "$ok" ]; then npm test && add test passed || { add test failed; ok=0; }; fi
          if [ -z "$ok" ]; then npm run build && add build passed || { add build failed; ok=0; }; fi
          sha=""
          if [ -z "$ok" ] && [ -f dist.zip ]; then sha=$(sha256sum dist.zip | cut -d' ' -f1); add artifact_verify passed; fi
          echo "stages=$stages" >> "$GITHUB_OUTPUT"; echo "sha=$sha" >> "$GITHUB_OUTPUT"
      - name: Report to AgencyOS (signed)
        env:
          SECRET: ${{ secrets.AGENCYOS_REPORT_SECRET }}
        shell: bash
        run: |
          artifact=null
          if [ -n "${{ steps.run.outputs.sha }}" ]; then
            artifact=$(jq -nc --arg sha "${{ steps.run.outputs.sha }}" '{sha256:$sha,type:"web_bundle",storageRef:"actions-artifact:dist.zip",distributable:true}')
          fi
          body=$(jq -nc --arg rid "${{ inputs.request_id }}" --arg did "${{ inputs.deliverable_id }}" --arg c "${{ inputs.commit }}" \
            --argjson stages '${{ steps.run.outputs.stages }}' --argjson artifact "$artifact" \
            --arg url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            '{requestId:$rid,deliverableId:$did,commit:$c,stages:$stages,artifact:$artifact,smoke:null,fingerprint:{os:"ubuntu-latest",runner:"github-actions"},command:"npm run build",runUrl:$url}')
          ts=$(date +%s)
          sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
          curl -fsS -X POST "${{ inputs.report_url }}" -H 'content-type: application/json' \
            -H "x-agencyos-timestamp: $ts" -H "x-agencyos-signature: $sig" --data "$body"
```

Adapt the install / lint / test / build commands to the project. The report must list the `source, env, install, lint_type, test, build` stages that ran;
a stage left out is treated as not run, and a success needs a built artifact with its sha256.

## Rules the endpoint enforces

- Unsigned, wrongly signed, stale (older than five minutes) or malformed reports are refused. The secret is never echoed.
- A report is accepted only for an **open build request** on that deliverable, commit and request id; the organization comes from the request row.
- One attempt per report: a retry is a new request (**Run the build** again).
- The build command may not deploy or publish. A deployment is Phase 7.

## Not proven

The dispatch request, the signature, the report schema and the recording are proven against fakes and in the database verifier. The live GitHub API and a real
workflow run are proven only when you provide the repository, token and workflow above.
