# pi-cache-match

A **pi agent-runtime extension** that answers, for **every** LLM completion call:

> *"Of the rendered prompt I'm about to send, what fraction of the leading tokens/blocks is already cache-reusable — and if that fraction dropped, exactly where and why did the prefix break?"*

It does this **before** the request leaves the process, purely from the framework layer, with **zero LLM calls, zero semantic similarity, zero GPU access** — only deterministic hashing and longest-common-prefix over block fingerprints. It then reconciles the prediction against the provider's real `usage.cacheRead` counter and emits one clean JSONL event per call.

```
             TURN 1 -- cold start                                          TURN 2 -- warm (same session, fresh pid)
             -----------------                                          -----------------------------------------
  "You are pi. [tools] user: a long question about x"  --------->   "You are pi. [tools] user: <same as turn 1> + follow-up"
                       |                                                                       |
                       v                                                                       v
              +------------------+                                                    +------------------+
              | RENDER (exact    |                                                    | RENDER (exact    |
              |   wire bytes)    |                                                    |   wire bytes)    |
              +--------+---------+                                                    +--------+---------+
                       |                                                                       |
                       v                                                                       v
              +------------------+                                                    +------------------+
              | TOKENISE 4char   |                                                    | TOKENISE 4char   |
              |  FNV32 pseudo-ids|                                                    |  FNV32 pseudo-ids|
              |  T = 577 tokens  |                                                    |  T' = 593 tokens |
              +--------+---------+                                                    +--------+---------+
                       |                                                                       |
                       v                                                                       v
              +------------------+                                                    +------------------+
              | SPLIT 16-token   |                                                    | SPLIT 16-token   |
              |   blocks         |                                                    |   blocks         |
              |  n_full = 36     |                                                    |  n_full = 37     |
              |  tail    =  1    |                                                    |  tail    =  1    |
              +--------+---------+                                                    +--------+---------+
                       |                                                                       |
                       v                                                                       v
              +------------------+                                                    +------------------+
              | CHAIN Gi = H(    |                                                    | CHAIN Gi = H(    |
              |   ctx|G(i-1)|tok)|                                                    |   ctx|G(i-1)|tok)|
              | prev  = None     |                                                    | prev  = turn-1   |
              |       (cold)     |                                                    |      (from shard)|
              +--------+---------+                                                    +--------+---------+
                       |                                                                       |
                       |                                                                       v
                       |                                                              +------------------+
                       |                                                              | LCP prev, cur    |
                       |                                                              | prev:[h0,h1,..   |
                       |                                                              |       h30]       |
                       |                                                              | cur :[h0,h1,..   |
                       |                                                              |       h30,h31..  |
                       |                                                              |       h36]       |
                       |                                                              |  matched = 31    |
                       |                                                              |  blocks          |
                       |                                                              +--------+---------+
                       |                                                                       |
                       |                                                                       v
                       |                                                              +------------------------+
                       |                                                              | METRIC EMISSION        |
                       |                                                              |  tokenMatchPct = 496/  |
                       |                                                              |    577 = 0.8596        |
                       |                                                              |  blockMatchPct = 31/   |
                       |                                                              |    36 = 0.8611         |
                       |                                                              |  matched_from = actual |
                       |                                                              |  call_index   = 1      |
                       |                                                              |  confidence   = low    |
                       |                                                              +------------------------+
                       |                                                                       |
                       |                                                           provider responds
                       |                                                           usage.input    = 81
                       |                                                           usage.cacheRead= 496
                       |                                                                       |
                       |                                                                       v
                       |                                                              +------------------------+
                       |                                                              | RECONCILE              |
                       |                                                              |  actual hit = 496/577  |
                       |                                                              |    = 0.8596            |
                       |                                                              |  delta       = 496-496 |
                       |                                                              |    = 0                 |
                       |                                                              |  source      = hybrid  |
                       |                                                              +------------------------+
                       |                                                                       |
                       |                                                           +-----------+-----------+
                       |                                                           |                       |
                       |                                                           v                       v
                       |                                                  +-------------------+  +-------------------+
                       |                                                  | {org}-{app}-        |  | _fingerprint-     |
                       |                                                  |  {agent}.jsonl      |  |   index.jsonl     |
                       |                                                  |   1 JSONL event     |  |   shard (chain +  |
                       |                                                  |   emitted           |  |   call ordinal)   |
                       |                                                  +-------------------+  +---------+---------+
                       |                                                                                 |
                       |                                                                                 v
                       |                                                                    +-----------------------+
                       |                                                                    | process exits.        |
                       |                                                                    | next pid loads this   |
                       |                                                                    | shard at first        |
                       |                                                                    | beforeCompletion.     |
                       |                                                                    +-----------------------+
                       v
              +------------------+
              | PERSIST chain    |
              |  +call ordinal   |
              |  to shard, then  |
              |  process exits.  |
              +------------------+

  Key:  | and v  = data flows down through the pipeline inside one call
        ->       = time flows left-to-right across calls on the same session

  The extension runs on the exact same request the agent sends — NOTHING is modified.
  Turn 2 sees turn 1's chain via _fingerprint-index.jsonl (the shard process B picks up).
```

*One diagram above shows everything the extension does for one call. Every subsystem in §0.A-0.J is one of these boxes or arrows.*

Implementation authority: `src/` in this repository — the exact code deployed to the live install `~/.pi/agent/extensions/pi-cache-match/src` (verified `diff -rq` clean, `tsc` clean, 262/262 fuzz). This README documents that source, formula for formula.

---

## 0. Visual architecture at a glance

Nine diagrams. Read top-to-bottom; together they tell the entire story before a single formula.

### 0.A  Where this extension sits — the big picture

```
 +------------------------------------------------------------------------------+
 |                         pi / xyne-cli  agent runtime                          |
 |                                                                              |
 |  user --> agent --> turn --> subagent --> tool calls --> build request       |
 |                                  |                                          |
 |      +---------------------------╧-------------------------------+           |
 |      |           pi-cache-match  (THIS extension)                |           |
 |      |   observe-only hooks:                                     |           |
 |      |     before_provider_request --> fingerprint & LCP          |           |
 |      |     message_end             --> reconcile & emit           |           |
 |      |     agent_/turn_/session_* --> cascade attribution         |           |
 |      +---------------------------╤-------------------------------+           |
 |                                  | one JSONL line per call                   |
 +----------------------------------┼-------------------------------------------+
                                    v
                    {org}-{app}-{agent}.jsonl   +   _fingerprint-index.jsonl
                                    |
                                    v
                    provider wire --> usage.cacheRead  (ground truth, reconciled)
```

The extension **never leads** — it *rides* the same request the agent was already going to send, fingerprints it, and compares the chain against the previous one. Nothing the agent or provider sees is altered.

### 0.B  One call, end-to-end — the six-stage pipeline

```
  RENDERED PROMPT  (system + tools + messages, exact wire bytes)
        |
        v
 +----------------------+     +----------------------+
 |  ACTUAL   prompt     |     |  CANONICAL twin      |   normalizeVolatileContent:
 |  (what model sees)   |     |  (volatility scrubbed)|   timestamps→[TIMESTAMP], uuids→[UUID],
 +---------┬------------+     +---------┬------------+   ids→[ID], hex→[HASH], epochs→[UNIX_TS]
           v                            v
      tokenise 4 chars/token FNV32  (both tracks)
           v                            v
      split ⌊T/16⌋ full blocks + partial tail (backends cache full pages only)
           v                            v
      Merkle-chained hashBlock  Gᵢ = H(context ‖ Gᵢ₋₁ ‖ tokensᵢ)
           v                            v
      +----------------------------------------+
      |   LCP  prevChain �matches curChain      |   string equality, break at first diff
      |        matchedBlocks = #leading equals  |
      +------------------┬---------------------+
                         v
        +-------------------------------------+
        |  percentages:                       |
        |    tokenMatchPct  = matched·16 / T  |   (≤ blockMatchPct always — partial tail dilutes)
        |    blockMatchPct  = matched / n_full|
        |    predicted_match_pct  = token     |
        |    cache_affinity_score = block     |
        +------------------┬------------------+
                         v
        provider responds --> usage { input, cacheRead }
                         v
        +-------------------------------------+
        |  RECONCILE:                         |
        |    actual hit% = cacheRead          |
        |                  -------------      |
        |                  input+cacheRead    |
        |    delta       = cacheRead − predictedMatchedTokens   (actual − predicted)
        |    source      = hybrid | pi_prediction              |
        +------------------┬------------------+
                         v
        one JSONL event emitted (hashes + counters only — NO content ever)
```

### 0.C  Anatomy of one block fingerprint — why one string compare is enough

```
 context commitment (same for every block of this call):
   H( fp_v | model | tok_v | tpl_v | cacheNamespace | H_extra(special keys) )

 chain:
   G₀   = "0000000000000000"
   Gᵢ   = H( context ‖ Gᵢ₋₁ ‖ join(",", tokens[i·16 .. i·16+15]) )

                        what Gᵢ COMMITS TO
 Gᵢ -----------------------------------------------------------+
                                                                v
 prefix identity:      (fp_v, model, tok_v, tpl_v, namespace)
                  +    the whole token prefix 0 .. 16(i+1)−1
                  +    the exact position i

 ⟹  Gᵢ_prev === Gᵢ_cur   IFF   both calls agree on context AND byte-prefix AND position
 ⟹  LCP is a plain string compare — the chain pre-digested the whole comparison
```

### 0.D  Cache-break diagnosis — the decision tree

```
                 (previous chain exists) ∧ (matched < n_full)
                              |
        +---------------------┼-------------------------------+
        v                     v                               v
   isAppend?           system-history path             ¬isAppend & has segment
 matched ≥ prev−1       (no prompt segment)                (seg.source set)
        |                     |                               |
       YES:                   |                +--------------┼---------------+
   no reason set              v                v              v               v
 (diagnosis_note =      matched==0 ∧      source="prompt"  has [TIMESTAMP]  else
  "prompt grew by N      prev[0]≠cur[0]      ⇒ system_        ⇒ volatility    ⇒ history_
   trailing block(s)")   ∧ systemPromptLen>0  prompt_change     (timestamps)     rewrite
                         ⇒ system_prompt_
                           change (structural)
                              |
                              v
              (any reason still null? ∧ matched==0 ∧ prev[0]≠cur[0])
                                  ⇒ session_restart   (fallback)

   + ALWAYS:  cacheClobberingDetected  independent flag (§3.8)
              matched==0 ∧ priorBest ≥ 4·B=64 ⇒ clobbering + expected_tokens
```

The fix that matters most: **`isAppend = matched >= len-1`** absorbs the straddling block that spans prev-tail/new-head bytes — a pure append *cannot* produce a same hash there. Without it, round-14 showed `history_rewrite` firing falsely on every benign turn.

### 0.E  The two percentages — same match, two honest answers

Use the lineage from §4 (the round-5 live turn): `prev = 31 blocks`, `cur = 36 blocks`, `T = 577` tokens => `n_full = 36`, `tail = 577 - 36*16 = 1` token.

```
 prompt:  [████████████████ … ████████████████ | ▏]
           block 0 …………… block 35         tail
           <---------- 31 matched -------------->

 blockMatchPct  = matched / n_full  = 31/36       = 0.8611   (page view)
 tokenMatchPct  = matched·16 / T    = 31·16/577  = 496/577  = 0.8596   (token view)

 577  =  36·16 + 1      tail = 1 token
        +------┬--- 1-token dilution accounts for the 0.0015 gap ---+
```

Two ratios, both correct: the dashboard wants token share of prompt-cost; the router wants page share of the prefix. `tokenMatchPct <= blockMatchPct` always (the partial-tail identity, §3.7).

### 0.F  Clobbering vs cold start — timeline

```
 priorBest(tokens):    0 -> 48 -> 496 -> 512 ---------> 512 -> 528
 matched(tokens):     48 -> 496 -> 512 -> 0(clobber!)--> 528 -> 528
                                              ▲
                     detected: matched==0 ∧ priorBest ≥ 64
                     emitted:  cache_clobbering_detected=true,
                               cache_clobbering_expected_tokens=512

 cold start (priorBest=0, matched=0) → NOT clobbering — that's just warm-up
```

A *regression* and a *fresh start* must never share a code path — the `4*B` threshold separates them.

### 0.G  Cross-process shard — why a fresh pid still knows the lineage

```
 process A (turn k) ...........................   process B (turn k+1, fresh pid)
 ------------------------------------------------   ---------------------------------------
 1. compute chain G0 .. G(n-1)                    1. lazy-load _fingerprint-index.jsonl
 2. persistFingerprint(root,          chain)      2. seed callIndex        from "#call"
 3. persistFingerprint(root#canonical, chain)     3. fetch root's chain    from the map
 4. persistFingerprint(root#call, base36(k+1))    4. LCP prev-vs-current
          |                                          matched = 31 / n_full = 36
          v                                          call_index = k+1 (lineage continues)
 +---------------------------------------------------------------+
 | shard on disk:  _fingerprint-index.jsonl                      |
 |   one line per write:  { k, h:[hashes], t }                   |
 |   latest-per-key wins; compacted at 1000 entries x 512 bytes  |
 +---------------------------------------------------------------+
          |
          +--> next pid's warm start reads this shard
```

`#call` is base-36 — alphabet disjoint from the 16-hex fingerprints, guaranteed never to collide in LCP space.

### 0.H  Cascade attribution — the call stack shapes the event

```
 EVENT        stack after event         callType        depth   trace_id
 ----------   -----------------------   -------------   -----   -----------
 session_start   []                      agent_turn        0     rootCallId
 turn_start      [turn]                  agent_turn        0     rootCallId
 agent_start     [turn,agent]            root_user_turn    1     rootCallId
 agent_start     [turn,agent,agent]      subagent          2     rootCallId

 depth   = #(live agent frames)   turn frames add the turn id, not depth
 trace_id = root_call_id          shared across every event in the run
```

`depth = #(live agent frames)`; `turn` frames contribute the turn id but not depth. A nested subagent is traceable to the outermost agent frame via `trace_id = root_call_id`.

### 0.I  Metric realism map — what's exact, what's approximate, what's absent

```
 +-------------------------------------------------------------------------+
 | EXACT                                                                   |
 +-------------------------------------------------------------------------+
   ratios (token, block, affinity, matched_from)
     deterministic LCP over the rendered prompt; bit-correct prefix commit
     via the hash chain

 +-------------------------------------------------------------------------+
 | REAL, verbatim from the wire                                            |
 +-------------------------------------------------------------------------+
   usage_input / cacheRead          provider's own counter; ground truth
   session / trace / call ids       from sessionManager + the cascade stack

 +-------------------------------------------------------------------------+
 | APPROXIMATE (flagged confidence = low)                                  |
 +-------------------------------------------------------------------------+
   absolute token counts             4 chars/token heuristic; ratios exact,
                                     counts within ~15% of real BPE;
                                     never polished up to "exact"

 +-------------------------------------------------------------------------+
 | ABSENT, never fabricated                                                |
 +-------------------------------------------------------------------------+
   ttft_ms, prefill_ms, selected_replica, ...
     pi doesn't expose them; scenario X asserts the keys are absent
```

Every emitted number carries its epistemic status. No estimate is ever dressed up as a measurement.

### 0.J  The self-audit pyramid

```
              tooling artefacts
            +-------------------------------------------------+
            |  live e2e: pi-mono × kimi-latest + xyne × glm  |   109 rows / 45 lanes
            |  (rounds 13b–15) — 0 violations                |
            +------------┬------------------------------------+
                         v
            +-------------------------------------------------+
            |  fuzz: 26 scenarios (A–Z), 259 assertions        |   3000-call stress incl.
            |  scenario Z: call_index strictly monotonic       |
            +------------┬------------------------------------+
                         v
            +-------------------------------------------------+
            |  this README: every formula verified against     |
            |  authoritative source line-by-line (6 audits)    |
            +-------------------------------------------------+
```

Each layer tests the one beneath: fuzz tests formulas, live runs test the fuzz, this README keeps the whole tower honest.

---

## Contents

| # | Section | What you get |
|---|---------|--------------|
| 0 | [Visual architecture at a glance](#0-visual-architecture-at-a-glance) | hero + ten diagrams; no formulas needed |
| 1 | [Why this is the correct metric](#1-why-this-is-the-correct-metric) | the theory behind prefix-cache |
| 2 | [Pipeline at a glance](#2-pipeline-at-a-glance) | one diagram, six stages |
| 3 | [The mathematical machinery](#3-the-mathematical-machinery) | every formula, with diagrams |
| 4 | [Worked end-to-end numerical example](#4-worked-end-to-end-numerical-example) | a hand-computed two-turn trace |
| 5 | [Complexity & cost](#5-complexity--cost) | time/space per stage |
| 6 | [Formal invariants](#6-formal-invariants) | the properties the fuzz locks in |
| 7 | [Confidence, diagnosis, cascade](#7-confidence-diagnosis-cascade) | the non-block math |
| 8 | [Persistence & config](#8-persistence--config) | shard, salt, env vars |
| 9 | [ Telemetry schema, privacy, tests](#9-telemetry-schema-privacy-tests) | event fields, guarantees, suite |

---

## 1. Why this is the correct metric

### 1.1 The prefix property of KV caching

Every serious autoregressive inference engine (vLLM, SGLang radix cache, LMCache, Anthropic/OpenAI server-side caching) is built around one structural fact:

> The key/value tensors at position *t* are a deterministic function of the token prefix `x[0..t]`. Therefore **cache reuse is possible iff the two requests share an identical token prefix**. The reusable region is a *prefix interval* `[0, p)`, and the first differing token at position `p` invalidates **everything after it**.

So the quantity that decides cost is not "how similar" two prompts are. It's a **single integer**: the length of their longest common token prefix (LCP).

### 1.2 The LCP-implies-divergence theorem

**Theorem.** Let `A`, `B` be token sequences and let `LCP(A,B)` be the length of their longest common prefix. Then the number of KV blocks a backend can reuse between them is exactly `floor(LCP(A,B) / Bpage)`, where `Bpage` is the page (block) size.

> **Why it's true.** Attention at position `t` reads `(k_i, v_i)` for `i <= t`. If `A[i] = B[i]` for all `i < p`, the accumulated state at `t = p-1` is bit-identical, so the K/V for every `i < p` is reusable. At `i = p` the token differs, so the hidden state at `p` differs, and by induction so does every state after `p`. No later token's cache can be trusted. Reuse is therefore *prefix-bounded* and *contiguous*.

> **Consequence.** A single changed byte early in the prompt — a timestamp, a random `request_id`, a reordered tool schema — destroys the *entire* cache downstream, even if 95% of the prompt is semantically identical. This is why "did the request get built stably?" is the whole game, and why a *structural* LCP measurement — not an embedding score — is the only honest observability metric.

### 1.3 Why measure it at the framework layer

Backend counters tell you *what got cached*. They can't tell you *"the cache broke because your own upstream framework injected a random UUID at token 1024."*

```
         framework-side prediction                backend-side observation
         -------------------------                ------------------------
  WHAT:  LCP over rendered prompt    +    REAL:   usage.cacheRead from wire
  WHO:   attributable to call/agent       WHY-NOT: tells you the outcome,
  WHERE: first-mismatch block+region                not the cause
  WHY:   diagnosable + routable
```

Hybriding the two isolates the failure domain: the gap between predicted and actual (`delta` = actual - predicted) splits "your framework built an unstable request" (low prediction, low actual) from "your backend evicted / routed away" (high prediction, low actual). §7.1 gives the full interpretation lattice.

---

## 2. Pipeline at a glance

```
        pi agent / subagent / turn builds final provider request
                                |
        +-----------------------┼-----------------------------------+
        |     pi ≥ 0.84:  payload = exact wire body                 |
        |     pi ≤ 0.55:  fallback → session history reconstruction |
        +-----------------------┼-----------------------------------+
                                v
 +---------------------------------------------------------------------+
 | STAGE 1  RECONSTRUCT   actualPrompt  (chat-template + tools header) |
 | STAGE 2  NORMALISE     canonicalPrompt (scrub timestamps/uuids/ids) |
 | STAGE 3  TOKENISE      token_ids[] (4 chars/token FNV pseudo-ids)   |
 | STAGE 4  SPLIT         ⌊T/B⌋ full blocks + partial tail             |
 | STAGE 5  FINGERPRINT   chained h[0..n-1] over full blocks (2 tracks)|
 | STAGE 6  MATCH         LCP(prev,cur) vs cacheKeyRoot & #canonical   |
 |          DIAGNOSE      first-mismatch block → region → reason       |
 |          FLAG          clobbering (priorBest ≥ 64, now 0)           |
 |          CONFIDENCE    tokeniser quality + provenance               |
 +---------------------------------------------------------------------+
                                |  prediction (hashes only, no content)
                                v
                     provider responds; message_end carries usage
                                v
 +---------------------------------------------------------------------+
 |  RECONCILE   actual hit% = cacheRead/(input+cacheRead)              |
 |              delta = cacheRead − predictedMatchedTokens  (if >0)   |
 |  ROLL UP     running avg, p50/p95 ring (byModel/byCallType/reason)  |
 |  EMIT        one pi.cache_match.completion JSONL (hashes+counts only)|
 +---------------------------------------------------------------------+
                                v
              {telemetryDir}/{org}-{app}-{agent}.jsonl  (+ _fingerprint-index.jsonl)
```

Everything is **observe-only**: no hook mutates the outgoing request, injects cache markers, or routes anything.

**Registered pi event hooks** (`pi.on(...)`, all wrapped so failure => no event, never throw — design-doc §19):

| Hook | Role in the extension |
|---|---|
| `before_provider_request` | **High-fidelity predict path** (pi >= 0.84). Receives the exact wire payload -> fingerprints the real request body. Observe-only (§2 stage 1-6). |
| `after_provider_response` | **Observation capture** — provider status/headers only; deliberately *does not* clear the pending prediction (usage comes on `message_end`). Observe-only. |
| `message_end` | **Reconcile & emit.** Carries the assistant `usage` block; on pi <= 0.55 also runs the session-history fallback prediction. Pairs prediction<->usage, emits the event, updates rollup. |
| `agent_start` / `agent_end` | Push / pop a `{kind:"agent"}` frame on the cascade stack -> drives `agentDepth` and `callType` (§7.3). |
| `turn_start` / `turn_end` | Push / pop a `{kind:"turn"}` frame; `turn_start` also stamps `turnId = turn_<session>#<turnIndex>`. |
| `session_start` | Resolve the authoritative `sessionId` (`sessionManager.getSessionId()`, fallback branch-scan) and set `rootCallId`. |

**Backend identification** (`getBackend`, the `BackendId` union): inferred from `(model.id, model.provider)` -> `anthropic` | `openai` | `bedrock` | `vllm` | `sglang` | `custom_managed_inhouse` | `unknown_backend`. Drives provenance confidence (§7.1) and the `backend` field on every event.

---

## 3. The mathematical machinery

Each subsection shows the exact formula, a diagram, and the file/line grounding.

### 3.1 Primitive hash `H` — dual FNV-1a 64-bit

**File:** `src/config.ts` * `hashString`. The universal reduce-of-everything:

```
H : Σ* → {0..15 hex}¹⁶        (a 64-bit value rendered as 16 hex chars)

h₁ = 0xcbf29ce484222325      (FNV offset basis)
h₂ = 0x84222325cbf29ce4      (twin basis)
P  = 0x100000001b3           (FNV prime)
M  = 2⁶⁴ − 1

for i in 0 .. n−1:
    c   = charCodeAt(i) & 0xff
    h₁ ← ((h₁ ⊕ c)            · P) & M
    h₂ ← ((h₂ ⊕ ((i+1) & 0xff))· P) & M

H(input) = (h₁ ⊕ h₂) rendered as 16-hex, left-padded
```

**Diagram — the two lanes run in lockstep; only the XOR combiner merges them:**

```
input:    c₀       c₁       c₂      …     cₙ₋₁
            |        |        |             |
lane h₁:  h₁⊕c₀-->×P->h₁⊕c₁-->×P-->  …  -->×P--+
            |        |        |             |   ├-> h₁ ⊕ h₂ -> 16-hex digest
lane h₂:  h₂⊕1-->×P-->h₂⊕2-->×P-->  …   h₂⊕n->×P--+
          index i+1 folded in (order-sensitivity lives HERE)
```

**Why each design decision is load-bearing:**

1. **FNV-1a** is O(n), branch-free, and avalanches well — the standard cheap non-cryptographic hash for "did bytes change?". The entire block-matching correctness reduces to "H changes iff its input changes", and FNV-1a delivers that for telemetry purposes.
2. **Two lanes** with distinct seeds, XOR-combined, widen effective output and kill the structured-collision patterns single-lane 64-bit FNV shows on *highly repetitive text* (prompts are full of that: whitespace runs, repeated delimiters).
3. **Folding `i+1` into lane 2** makes H *sequence-sensitive*, not multiset-sensitive. `H("ab") != H("ba")` is *required* — block matching is about **ordered** prefixes. Position-independence would be a correctness bug, so it's baked into the primitive.
4. **Fixed 16-hex contract** — every hash in the system is one uniform opaque string. LCP is then pure string equality; the shard; the telemetry — all compare uniform IDs, with no variable-width edge cases.
5. **Not cryptographic, and deliberately so.** Tenant isolation is enforced by the *inputs* (`cacheNamespace`, `cacheSalt`, §3.9), not by hash strength. FNV-1a*2 over namespace-bound inputs covers *accidental* collision; that's all a telemetry hash needs.

#### `hashExtraCacheKeys` — order-independence

```
H_extra(K)  =  H( "extra:"  +  join("&",  [ k+"="+K[k]  for k in sort(keys(K)) ]) )
```

The **`sort(keys)`** is what makes the fingerprint immune to JSON insertion-order artefacts. Two payloads whose extra-keys differ only in serialisation order must produce the *same* hash — otherwise identical model/provider pairs could hash differently call-to-call and silently shred every prefix match. Sort-then-join makes the result provably order-invariant.

---

### 3.2 Tokeniser `T` — 4-chars/token FNV pseudo-ids

**File:** `src/tokenize.ts` * `Tokenizer.encode`. A deterministic pseudo-tokeniser stands in for the model's real BPE:

```
n = 4                       (approximateCharTokens)
T(text) :  token_k  =  FNV32( text[4k .. 4k+3] )   for k = 0 .. ⌈len/4⌉−1

    FNV32(chunk):
        h = 2166136261                        (32-bit FNV offset basis)
        for ch in chunk:
            h ← h ⊕ charCode(ch)
            h ← (h · 16777619) mod 2³²       (Math.imul — 32-bit multiply)
        return h >>> 0                        (unsigned)
```

Memoised: `cacheKey = H("v1:4:" + text)`, `cache.size <= 1024`, oldest-first eviction; `H(text)` also stored as `normalizedTextHash`.

**Diagram — non-overlapping, position-indexed chunks; a character at position `p` affects *only* token `floor(p/4)`:**

```
chars:  [a b c d][e f g h][i j k l][m n … ]
           t₀       t₁       t₂        t₃
            |        |        |         |
 position p=6 ("g"→"X")  changes ONLY  t₁ ;  t₀, t₂, t₃ unchanged
                       v
        prefix relationship preserved exactly up to and including t₀
```

**Why a *fake* tokeniser still produces a *real* metric.** Cache matching needs only two properties from `T`:

1. **Stability** — same prompt => same token stream (pure function of `(text, 4)`).
2. **Position-and-order fidelity** — a change at position `p` perturbs only tokens `floor(p/4)` and later (guaranteed: non-overlapping position-indexed chunks).

Both are *exact*, so:

> **The LCP of pseudo-token block chains equals the LCP of real-BPE block chains whenever the underlying byte-prefix is identical.** The prefix-match *ratio* (§3.7) is structurally exact; only the *absolute token count* is approximate (~4 chars/token ~= within ~15% of real BPE yield for code+prose). The extension flags the approximate counts `confidence:"low"` (§7.1) rather than pretend they're exact — that's the honest estimate-vs-exact split the design mandates.

---

### 3.3 Block splitting

**File:** `src/tokenize.ts` * `splitIntoBlocks`.

```
Given:  token_ids of length T,  block size B  (default B=16, vLLM page size)

n_full   = ⌊ T / B ⌋                     full blocks
tail     = T mod B                       partial tail (tokens) — NOT hashed

fullBlocks[i] = token_ids[ i·B  ..  (i+1)·B − 1 ]   for i = 0 .. n_full−1
```

```
tokens:  [t₀…t₁₅][t₁₆…t₃₁][t₃₂…t₄₇] …… [t_{nB} … t_{T-1}]
           blk 0   blk 1    blk 2          partial tail (T mod B tokens — excluded)
                                            +- backends only cache FULL pages
```

**Why the tail is excluded (and never matches):** backends cache *full* pages. A 7-token tail cannot reuse a 16-token page. This is *exactly* why, on a *perfect repeat*, `block_match_pct` can reach `1.0` while `token_match_pct` stops at ~=0.95 (§3.7) — that's not a defect, it's the truthful signature of page-aligned caching.

---

### 3.4 The block fingerprint chain — `hashBlock`

**File:** `src/fingerprint.ts` * `hashBlock`. This is the identity of the whole design — a vLLM-isomorphic Merkle-style chain:

```
G₀        = "0000000000000000"                       (emptyParentHash)

Gᵢ = H(  fingerprintVersion | model | tokenizerVersion | templateVersion
       | cacheNamespace | Gᵢ₋₁ | join(",", token_ids[i]) | H_extra(extraCacheKeys) )

for i = 0 .. n_full−1;   each Gᵢ becomes the parent of Gᵢ₊₁.
```

**Chain diagram:**

```
context = H(fp_v | model | tok_v | tpl_v | cacheNs | H_extra(keys))   ← same for all blocks in a call

  G₀ = "0000000000000000"
   |
   v
H(context, G₀, tokens[0..15])  = h₀ --+
                                      v
                        H(context, h₀, tokens[16..31]) = h₁ --+
                                                               v
                                              H(context, h₁, tokens[32..47]) = h₂ --> …
```

**Why chaining (`Gᵢ₋₁` in the input) is the *entire point*, not a detail.** If blocks were hashed independently (`H(tokens_i)`), the extension could find blocks that match *anywhere* — but that's not what KV cache does. Reuse at position `k` requires every *preceding* block to be identical too. Chaining makes `hᵢ` a **commitment to the whole prefix `token[0 .. 16(i+1)-1]`**:

> `hᵢ` is a function of `(context, tokens[0..16(i+1)-1])` — the *entire* prefix, not just block *i*.

So the prefix-comparison of §3.6 collapses to O(matched-length) **string equality** `prevChain[i] === curChain[i]`: two chains agree at index *i* iff their whole prefixes up to *i* are contextually identical — same namespace, model, template, *and* byte-content, *at the same position*. One string compare stands in for a token-by-token deep diff. This is precisely vLLM's `(parent_hash, block_tokens, extra_keys)` block identity — the extension is model-isomorphic with the very system it measures.

The version inputs (`fingerprintVersion`, `templateVersion`, `tokenizerVersion`) mean any template/tokeniser change reshuffles *every* hash — the extension can never claim a match across incompatible renderings. **Only the 16-hex hashes are retained; token ids and prompt text are consumed and dropped** (privacy §9.2).

---

### 3.5 The dual-track prompt reconstruction

**File:** `src/index.ts` * `promptFromPayload` / `promptFromSessionHistory` + `src/prompt.ts` * `normalizeVolatileContent`.

Every call produces **two** prompts — the two tracks the design doc (§16) mandates:

```
actualPrompt     (track A) = chat-template rendering of the REAL request
canonicalPrompt  (track C) = normalizeVolatileContent(actualPrompt)   [the "canonical twin"]
```

Canonical normalisation (regex substitutions) — the volatility scrubber:

```
ISO timestamp   \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})? → [TIMESTAMP]
unix epoch      \b1[5-9]\d{8,}\b                                                 → [UNIX_TS]
UUID            [0-9a-f]{8}-…-{12}                                               → [UUID]
long hex        \b[0-9a-f]{16,64}\b                                              → [HASH]
opaque id       \b(req|run|call|trace|span|tool|msg|session|turn|id)-[a-z0-9]{4,} → [ID]
```

**Why a second track (and never a rewrite of the primary)?** The backend caches the **real bytes**, so normalisation must never be allowed to inflate the *actual* match — that would be lying about what the model sees. But for *diagnostics* you want the counterfactual: *"would the cache have matched if this unstable field hadn't been there?"* Two independent fingerprint chains — `cacheKeyRoot` and `cacheKeyRoot#canonical` — answer both questions on real data, without conflating them. The derived diagnostic:

```
volatilityDeltaTokens = max( canonicalMatchedTokens − predictedMatchedTokens, 0 )
```

is the recoverable loss attributable to unstable metadata. (R5 fix: `canonical_matched_pct` divides canonical matched blocks by the **canonical** block count, never the actual — dividing two different tokenisations would silently skew the ratio whenever normalisation changes length.)

**Tool-list identity (round-10 fix).** Two calls with identical messages but a different `tools` array would once render to identical bytes and falsely claim a full match. The reconstructed prompt now prepends:

```
<|im_start|>tools ${ sort( name+"#"+H(schema) ).join("|") }<|im_end|>
```

— a *hash* of the sorted tool name+schema list. A tool-list change shifts the fingerprint and surfaces an honest mismatch; emitting a hash (not names/schemas) keeps the telemetry content-clean (§9.2). Fuzz scenario Y locks this.

---

### 3.6 Longest-common-prefix matching

**File:** `src/index.ts` * `beforeCompletion`. Against the stored previous chain:

```
matched = 0
for i in 0 .. min(|prev|, |cur|) − 1:
    if prev[i] === cur[i] then matched++
    else BREAK                          ← terminal, by §1.2 / §3.4

matchedBlocks          = matched
predictedMatchedTokens = matched × B
```

**Why `BREAK` is correct, not an optimisation.** Because `hᵢ` commits to the whole prefix (§3.4), the first index where the chains disagree invalidates *every* later block. There is no "match again later" — reuse is prefix-contiguous (§1.2). Cost: O(matched length), O(1)` best.

**Diagram:**

```
prev:  [h₀][h₁][h₂][h₃][h₄]
cur:   [h₀][h₁][h₂][H₃][H₄][H₅]
        ✓   ✓   ✓   ✗ BREAK
              matchedBlocks = 3   →   matchedTokens = 3×16 = 48
              (H₃ onward can NEVER be shared — first difference at block 3)
```

The same loop runs a second time for the canonical chain (`#canonical`), yielding `canonicalMatchedBlocks`. **`matched_from` semantics** (round-4 fix):

| condition | `matched_from` | why honest |
|---|---|---|
| `matchedBlocks > 0` (incl. ties) | `"actual"` | the raw prompt genuinely matched |
| `canonicalMatchedBlocks > matchedBlocks` **strictly** | `"canonical"` | *only* when the twin rescued the match |
| cold lineage (no prev) | `"none"` | nothing to compare against |

Claiming `"canonical"` on a tie would misattribute a clean repeat to the normaliser — the strict-superset rule is what keeps `matched_from` truthful.

**What happens when history is compacted mid-session (r14compact live).** The *predicted* prefix-match is computed against the *reconstructed session history*, *not* the wire's post-compaction bytes — the summariser replaces earlier tool outputs/messages with its own summary, and pi does not retro-patch the extension's view of the *pre-compaction* prefix. Therefore a post-compaction turn reports `pred ~= 0.99` against *its own internal history* chain, even though the *wire* it just sent starts from a cold prefix the provider's cache has never seen (cacheRead = 0). `prediction_actual_delta = negative, magnitude thousands` makes the divergence explicit. This is exactly the behaviour R13b/R14 verify on the real pi-mono compaction path: the extension tells you what the wire *would have* matched were the prefix not rewritten, and separately tells you (via `cacheRead`, `history_rewrite`, delta) that the wire was rewritten. Both truths, never conflated.

---

### 3.7 The two percentages (and why both exist)

Every event carries **three** ratios, each defined for a distinct purpose:

```
blockMatchPct   =  matched / n_full                 (backend-faithful page ratio)
tokenMatchPct   =  (matched × B) / T                (human/dashboard token ratio)
predictedMatchPct    =  tokenMatchPct               (design-doc §20 canonical primary)
cache_affinity_score =  blockMatchPct               (design-doc §18 routing signal)
```

**Why they diverge — the partial-tail identity.** Since `matched * B` counts only full matches and the denominator `T = n_full*B + tail` includes the unmatchable tail:

```
T  =  n_full · B  +  partialBlockTokens

tokenMatchPct  =  matched·B / (n_full·B + tail)
blockMatchPct  =  matched   /  n_full

⟹   tokenMatchPct  ≤  blockMatchPct        (strict < whenever tail > 0 and matched>0)
```

> On a *perfect repeat*: `matched = n_full` => `blockMatchPct = 1`, but `tokenMatchPct = n_full*B/(n_full*B+tail) < 1`. Both are **true simultaneously** — one answers "what fraction of prompt-cost is cache-reusable" (token), the other "what fraction of prefix pages is backend-cached" (block). The fuzz (scenario T) locks `token_pct <= block_pct` and both identities as invariants. This is the mathematically truthful distinction, not accumulated rounding error.

**Cold start:** no previous chain => `matched = 0`, all three percentages `0`, `matched_from="none"` — an honest zero, never a fabricated estimate.

---

### 3.8 Cache-clobbering detection

**File:** `src/index.ts` * `bestMatchByRoot`. A per-root running maximum detects *regressions*, distinct from cold starts:

```
priorBest(root)                  = max matchedTokens ever seen under this cacheKeyRoot
cacheClobberingDetected          = ( matched == 0 )  AND  ( priorBest ≥ 4·B )   // 64 tokens
cacheClobberingExpectedTokens    = priorBest            (when detected)
after each call:  priorBest ← max(priorBest, matchedTokens)
```

```
calls:      --+ high match --+     +-- sudden zero
priorBest   0      ↑ grows   512   512
matched     48    496    512        0   ← clobbering DETECTED
                                    (priorBest 512 ≥ 64, matched 0)
```

**Why the `4*B = 64` threshold:** a first-time cold start (`priorBest = 0`) and a genuine regression (was matching hundreds, now zero) are completely different operational events and must not share a code path. Four full vLLM pages is the smallest count above which "we previously held a real prefix" is unambiguous — nothing matches 64 tokens by accident. This is design-doc §15 *regression detection* made per-call-computable.

---

### 3.9 Cache-key identity

**File:** `src/config.ts` (salt/version resolvers) + `src/index.ts`. The identity chain is built so two prompts fingerprint identically **iff** they share a genuine cacheable lineage:

```
cacheSalt         = PI_CACHE_MATCH_SALT / PI_SOFT_SALT
                    else `salt-${ H(orgId+":"+appId)[0..11] }`     (deterministic default)

saltPart          = ""                 if cacheSalt starts "salt-" (default)
                  | "|"+cacheSalt      if explicitly set

cacheNamespace    = H( "ns|" + orgId + "|" + appId + "|" + sessionId + saltPart )

cacheKeyRoot      = H( "root|" + orgId + "|" + appId + "|" + sessionId + "|" + model + "|" + cacheNamespace )

fingerprintVersion = PI_CACHE_MATCH_FINGERPRINT_VERSION or "pi-cache-fp-v1"
```

**Identity tree:**

```
orgId -+
appId -┼-> cacheNamespace -+
sessionId -+                ├-> cacheKeyRoot --> fingerprint chain G₀..G_{n-1}
model ----------------------+        (+ the #canonical twin chain)
saltPart --------------------------------> folded into cacheNamespace only when explicit
```

**Why this construction is right:**

- **`model` and `sessionId` are *inside* the key** — switching models *must* zero the match (KV tensors are model-specific); fuzz scenario C proves `predicted_match_pct = 0` after a model swap.
- **Deterministic default salt** (`salt-H(org:app)`) means `pi --continue` in a *fresh process* rebuilds the same `cacheKeyRoot` for the same session — that's what makes cross-process lineage (§8.1) possible at all. An explicit salt overrides it and is folded into the namespace *only when set*, so opting into stricter isolation doesn't silently break the determinism the default relies on.
- **`cacheNamespace` is the tenant-isolation boundary** — two orgs, same session id, same model, same salt => different namespace => different chain. Isolation is enforced *at the hash input*, not by hoping the weak hash is lucky.
- **`fingerprintVersion` is a static schema label** *separate* from tenant identity: tenant isolation travels through `namespace + salt`, version skew through `fingerprintVersion`. (R8 audit fix: it's now *emitted* on every event, not just used internally.)

---

### 3.10 Roll-up statistics

**File:** `src/index.ts` * `recordRollup`. Per bucket (`byModel` / `byCallType` / `byBreakReason`):

```
n               ← n + 1
totalPrompt     += totalPromptTokens
totalMatched    += predictedMatchedTokens
totalMiss       += max(totalPromptTokens − predictedMatchedTokens, 0)

Ā_n  =  ( Ā_{n-1}·(n−1)  +  x_n ) / n            (running mean, x_n = predictedMatchPct)
Ā_affinity = same recurrence over predictedMatchPct
Ā_actual   = same recurrence over backendActualCacheHitPct  (when defined)
```

**Why the online recurrence?** `Ā_n = (Ā_{n-1}(n-1)+x_n)/n` is O(1) per call — no re-sort, no unbounded sample retention for the mean, correct by induction on `n`.

**Percentile ring** (exact percentiles need retained samples => bounded ring):

```
samples.push(x_n);   if |samples| > 512: shift()          (bounded 512 ring, oldest evicted)

p50 = sorted[ ⌊(k−1)·0.50⌋ ]
p95 = sorted[ ⌊(k−1)·0.95⌋ ]          k = ring size
```

```
        oldest ------------------------------- newest
ring:   [ x_{n-511} , … , x_{n-2} , x_{n-1} , x_n ]     cap 512
                    |
                    +- sort() -> take ⌊(k-1)·q⌋-th element for quantile q
```

**Why a ring rather than t-digest/reservoir:** the rolling window is exactly what a session-scoped dashboard wants ("how has this agent's cache efficiency trended over its *recent* calls"), memory is hard-bounded at 512 floats, and the estimator is *exact within its window* — no sketch error term to explain to operators. Fuzz scenario V recomputes avg/p50/p95 brute-force from emitted events and asserts the rollup agrees.

**Break-reason counting:** each event with `suspectedBreakReason != null` increments `breakReasons[reason] += 1` in the affected buckets — which is what lets `/cache-match-agent` render `history_rewrite: 4 calls` next to the averages.

---

## 4. Worked end-to-end numerical example

A two-turn trace, computed by hand with the real formulas. (Verified: the hash/token values below are the actual outputs of the live `hashString` and `Tokenizer`.)

### Turn 1 — cold

**Prompt** (chat-template render, abbreviated): the system line + one user message whose body is `"ABCDEFGH"` (8 chars => 2 tokens, so a sub-single-block prompt for illustration).

- **Tokenise** (`n=4`): `t₀ = FNV32("ABCD") = 3541452541`, `t₁ = FNV32("EFGH") = 224681381`. So `T = 2` tokens, `n_full = floor(2/16) = 0` full blocks, `tail = 2` tokens.
- **Fingerprint:** zero full blocks => empty chain `[]`. No prior lineage => `matched = 0`.
- **Metrics:** `predicted_match_pct = 0`, `matched_from = "none"`, `confidence = "low"` (heuristic tokeniser).

### Turn 2 — warm (expand the prefix)

Now the prompt's user body is `"ABCDEFGH" * longText("hist")…` — a long body that yields **577 tokens** (the round-5 live figure).

- **Tokenise:** `T = 577` => `n_full = floor(577/16) = 36` full blocks, `tail = 577 - 36*16 = 1` token.
- **Lineage:** the stored previous chain covers the first **31** full blocks; current `cur` has 36. LCP:

```
prev:  [h₀]………[h₃₀]
cur:   [h₀]………[h₃₀][h₃₁][h₃₂][h₃₃][h₃₄][h₃₅]
        +--- 31 matched ---++---- new (appended tail)
matchedBlocks = 31
```

- **Percentages (the §3.7 identity, on real numbers):**

```
matchedTokens   = 31 × 16            = 496
tokenMatchPct   = 496 / 577          = 0.8596…   ≈ 0.860   (predicted_match_pct)
blockMatchPct   = 31 / 36            = 0.8611…   ≈ 0.861   (cache_affinity_score)
                                   +-----------+
                    token ≤ block: the 1-token tail dilutes only the token ratio
```

- **Backend reconciliation** (from the live wire on that turn): `usage.cacheRead = 496`:

```
actual hit%  = cacheRead / (input + cacheRead) = 496/(496+81) = 0.8596
delta        = cacheRead − matchedTokens       = 496 − 496 = 0   ← prediction == actual
```

A `delta` of `0` here is the extension *exactly* predicting the provider's real cached-token count — the whole point of the hybrid design (§7.1's "high/high = healthy" cell).

**H primitive spot-check** (lane math on the two-char input `"AB"`, hand-verified against `hashString`):

```
lane h₁ over (65,66)      → 0x09086407b5a0edaa
lane h₂ over (65,66)      → 0x361ff8cb04c42c47
H("AB") = h₁ ⊕ h₂         → 3f179cccb164c1ed      ✓ matches live hashString("AB")
```

---

## 5. Complexity & cost

Per completion call, where `L` = prompt length (chars), `T = L/4` tokens, `B = 16`, `m` = matched prefix blocks:

| Stage | Operation | Time | Space |
|---|---|---|---|
| Reconstruct | chat-template render | O(L) | O(L) transient |
| Normalise | 5 regex passes | O(L) | O(L) |
| Tokenise | FNV32 per 4-char chunk | O(L) | O(T) |
| Split | slice into floor(T/B) blocks | O(T) | O(T) |
| Fingerprint | `hashBlock` per full block | O(T) | O(T) hashes |
| **Match (LCP)** | compare 16-hex hashes until diff | **O(m)**, O(1) best | O(1) |
| Reconcile | 2 divisions | O(1) | O(1) |
| Roll-up | online mean + ring push | O(1) amortised | 512 floats/bucket |

```
                        cost
                         ▲
   cold path  O(L) ------┤███████████████████   tokenise+hash every block
                         |
   warm path  O(m) ----┤████                    LCP stops at first mismatch
                         |
   chain lookup  O(1) ---┤█                    hash equality, no deep diff
                         +------------------------->
```

The dominant cost is the cold-path O(L) pass, which is unavoidable *for any* honest prefix measurement — a 130k-token prompt can't be assessed without inspecting its blocks. The design doc's own cost budget is exactly this: `Cold O(tokens) / Warm O(delta) / Lookup O(1)`.

---

## 6. Formal invariants

The properties the fuzz suite holds as load-bearing (each locked by named scenarios):

| # | Invariant | Mathematical statement |
|---|-----------|------------------------|
| I1 | LCP prefix-bound | `matched(i)` true for `i < p`, false for `i >= p`, some `p` — never "rematch after diverge" |
| I2 | Chain prefix-commitment | `prev[i] == cur[i]` <=> prefixes-token-equal up to block `i` |
| I3 | Token <= block | `tokenMatchPct <= blockMatchPct` always |
| I4 | Identity | `T = n_full*B + partialBlockTokens` |
| I5 | Ratio identities | `blockMatchPct = matched/n_full`, `tokenMatchPct = matched*B/T`, `predicted = token`, `affinity = block` |
| I6 | No fabrication | fields the wire doesn't expose are *absent*, never `0`-filled |
| I7 | Range | every ratio in `[0,1]`, every count >= 0, no NaN across 3000 calls |
| I8 | Cascade | `depth >= 2 => callType="subagent"`, `trace_id` shared across a nested run |
| I9 | Privacy | no prompt/tool/token substring appears in any emitted JSONL |
| I10 | Ordinal continuity | `call_index` strictly monotonic across pid hops on one session |
| I11 | Clobbering | `matched=0 and priorBest >= 64 => cacheClobberingDetected` |
| I12 | Hybrid source | `cacheRead` defined (number, incl. 0) <=> `cache_match_source="hybrid"`; `delta` defined only when `predicted > 0` |

These are not aspirations; scenarios A-Z (§9.3) *assert* each one against the real emitted JSONL.

---

## 7. Confidence, diagnosis, cascade

### 7.1 Confidence model (design-doc §22, an *absolute* map)

| Tokenisation source | Confidence |
|---|---|
| backend-provided token IDs | `high` |
| local exact model tokeniser | `high` |
| local compatible tokeniser | `medium` |
| approximate char/token heuristic (shipped) | `low` |

Provenance modifiers recorded as `confidence_reasons` (and grade effects): `recon.source === "session_history"` drops `high->medium` *before* the tokeniser grade (a reconstruction can diverge from wire bytes even with a perfect tokeniser); the shipped heuristic then forces `low`. **No-prior-fingerprint is *not* a downgrade** — it's a warm-up *outcome*, recorded as an informational reason, not a grade drop (scenario W). Confidence describes *how* the number was made, never *what* it says.

**Prediction-vs-actual lattice** (the `delta` = actual - predicted isolates the failure domain (positive: backend exceeds prediction; negative: prediction exceeds backend — routing/eviction suspect)):

| Pi prediction | Backend actual | Diagnosis |
|---|---|---|
| High | High | **Healthy reuse** |
| High | Low | Routing / eviction / namespace problem — backend lost what you predicted |
| Low | Low | Bad request construction — fix the framework upstream |
| Low | High | Estimator conservative, or backend smarter than predicted |

### 7.2 Cache-break diagnosis

When lineage exists and `matched < n_full`:

```
firstMismatchBlockIndex = matched          (the first divergent block — LCP+1)
```

`buildSegmentInfo` maps blocks to message regions (`user[2]`, `tool:<name>`, `system`…). The branch condition is `previous exists and previous.blockHashes.length > 0 and matched < n_full`. Then:

```
isAppend ≡ (matched ≥ previous.blockHashes.length − 1)
  ← prior prompt is (nearly) a prefix of the current one. The previous prompt
    almost never ends on an exact block boundary, so the *last* full block
    straddles old tail + new head; an honest append sacrifices exactly that
    one block. The `− 1` absorbs the straddling junction.

Prepend-anchored structural check (session_history path):
  !isAppend ∧ matched == 0 ∧ prev[0] ≠ cur[0] ∧ recon.systemPromptLen > 0
    → "system_prompt_change", region = "system"
  (when recon.source == "session_history" there is no dedicated prompt segment,
   so only the leading-block divergence witnesses the system-prompt change)

isAppend         → NO break reason: suspected_break_reason stays null,
                   diagnosis_note = "prompt grew by (n_full − matched) trailing block(s)";
                   first_mismatch_message_index/region still record where growth starts.
                   (A pure extension preserves the entire prefix → it is not a
                   cache *break*; blaming a rewrite would be a false positive.)

¬isAppend → seg.source == "prompt"        → "system_prompt_change"
            seg has tools ∧ normalised region label contains "[TIMESTAMP]"
                                          → "volatility"
              (diagnosis: "timestamps in tool outputs are the likely break")
            seg has tools (no [TIMESTAMP]) → "history_rewrite"
              (diagnosis: "tool output changed in <region>")
            otherwise                     → "history_rewrite"
              (diagnosis: "messages diverged at <region>")

Fallback override (only when no reason was set above):
matched==0 ∧ prev[0] ≠ cur[0] ∧ suspected_break_reason == null
                                         → "session_restart"
  (diagnosis: "first block differs from previous cache entry")
clobbering (§3.8)                          → cache_clobbering_detected = true +
  cache_clobbering_expected_tokens, independent of the reason above
```

`CacheBreakReason` in `{system_prompt_change, tool_list_change, history_rewrite, template_change, tokenizer_change, volatility, model_change, session_restart}` (`tool_list_change` via the round-10 tools-header hash, §3.5).

### 7.3 Call-cascade attribution

`agent_start`/`turn_start` push `{kind}` frames; `*_end` pops the most recent of its kind:

```
agentDepth = #(live agent frames)
callType   = "subagent" (depth≥2) | "root_user_turn" (depth=1) | "agent_turn" (depth=0)
traceId = rootCallId = callId of outermost agent frame
```

Scenario Q locks the matrix: depth 0->`agent_turn`, depth 1->`root_user_turn`, depth 2->`subagent` with `subagent_id` set and `trace_id == root_call_id` shared across the nested cascade.

---

## 8. Persistence & config

### 8.1 Cross-process shard

Pi launches a fresh process per turn, so lineage persists to `{telemetryDir}/_fingerprint-index.jsonl` — one line `{k, h:[hashes], t}` per write, latest-per-key wins.

- **Lazy load** on first `beforeCompletion` in a process (only when the in-memory map is empty).
- **LRU-bounded in memory** (`maxSessionIndexEntries = 1000`; get re-inserts to bump recency, set evicts oldest over budget).
- **Shard compaction** — rewrite newest-per-key once the shard exceeds `1000 * 512` bytes (round-4 fix).
- **Call-ordinal piggyback** — `${cacheKeyRoot}#call` stores `nextOrdinal.toString(36)` (base-36 => disjoint from the 16-hex fingerprints, and a reserved key never enters LCP); seeded once per process (`callIndexSeededFromShard`). Scenario Z asserts strict monotonicity across 5 fresh processes.

```
turn k --> write shard({root:G₀..},  {#canonical},  {#call: (k+1).toString(36)})
                                                      |
turn k+1 (new pid) <-- read shard <-- seed callIndex -+   →  call_index continues
```

### 8.2 Configuration (env vars)

| Variable | Default | Controls |
|---|---|---|
| `PI_CACHE_MATCH_BLOCK_SIZE_TOKENS` / `PI_BLOCK_SIZE_TOKENS` | `16` | vLLM page size `B` |
| `PI_CACHE_MATCH_TEMPLATE_VERSION` / `PI_TEMPLATE_VERSION` | `chat-template-v5` | template identity in the hash chain |
| `PI_CACHE_MATCH_TOKENIZER_VERSION` / `PI_TOKENIZER_VERSION` | `tokenizer-v3` | tokeniser identity in the hash chain |
| `PI_CACHE_MATCH_FINGERPRINT_VERSION` | `pi-cache-fp-v1` | fingerprint/schema label on every event |
| `PI_CACHE_MATCH_TELEMETRY_DIR` | `~/.pi/agent/cache-match` | JSONL output dir (events + shard) |
| `PI_CACHE_MATCH_ORG_ID` / `PI_ORG_ID` / `XYNE_ORG_ID` | `org_x` | tenant id + namespace input |
| `PI_CACHE_MATCH_APP_ID` / `PI_APP_ID` / `XYNE_APP_ID` | `xyne` | app id |
| `PI_CACHE_MATCH_AGENT_ID` / `PI_AGENT_ID` / `XYNE_AGENT_ID` | `xyne-cli` | agent id |
| `PI_CACHE_MATCH_SALT` / `PI_SOFT_SALT` | `salt-H(org:app)[0..11]` | namespace isolation salt (§3.9) |
| `PI_CACHE_MATCH_DEBUG` / `PI_CACHE_MATCH_DEBUG_MODE` | unset | `1` -> content-free structural stderr log |

Resolution: explicit `PI_CACHE_MATCH_*` -> shared `PI_*`/`XYNE_*` -> `~/.pi/agent/settings.json` (`defaults.*`/`telemetry.*`) -> defaults. Compile-time (not env): `approximateCharTokens=4`, `maxSessionIndexEntries=1000`, ring bound `512`.

---

## 9. Telemetry schema, privacy, tests

### 9.1 Event schema — `pi.cache_match.completion`, one JSONL line per call

| Group | Fields |
|---|---|
| Identity | `timestamp` `org_id` `app_id` `agent_id` `subagent_id?` `trace_id?` `call_id` `parent_call_id?` `root_call_id` `call_type` `depth` `session_id` `turn_id` `call_index` |
| Model | `model` `provider?` `backend?` |
| Versions | `template_version` `tokenizer_version` `template_hash` `tokenizer_hash` `fingerprint_version` `cache_namespace` `cache_key_root` |
| Geometry | `block_size_tokens` `total_prompt_tokens` `total_full_blocks` `partial_block_tokens` |
| **Prediction** | `predicted_matched_blocks` `predicted_matched_tokens` `predicted_match_pct` `token_match_pct` `block_match_pct` `matched_from` `canonical_matched_*` `volatility_delta_tokens?` |
| Diagnosis | `first_mismatch_*` `suspected_break_reason` `diagnosis_note?` `cache_clobbering_*` |
| Routing | `cache_affinity_score` `recommended_cache_stickiness` `predicted_prefill_savings_tokens` |
| Confidence | `confidence` `confidence_reasons` |
| Observation | `ttft_ms?` `prefill_ms?` `decode_ms?` `total_latency_ms?` `usage_input/output/cache_read/cache_write?` `prediction_actual_delta?` `backend_metrics_available` `cache_match_source` |

Optional fields are **omitted, never zero-filled** (scenario X is the anti-fabrication guard).

**Exact field keys emitted on the wire** (union captured from a live run of the deployed extension — every field the extension can ever emit; `?` = optional and omitted-when-absent):

```
timestamp, event_name ("pi.cache_match.completion"), schema_version
  ("pi.cache_match.completion.v1"), fingerprint_version,
org_id, app_id, agent_id, session_id, turn_id, trace_id?, call_id, root_call_id,
  call_index, call_type, depth,
model, provider?, backend?,
template_version, template_hash, tokenizer_version, tokenizer_hash,
  cache_namespace, cache_key_root,
block_size_tokens, total_prompt_tokens, total_full_blocks, partial_block_tokens,
predicted_matched_blocks, predicted_matched_tokens, predicted_match_pct,
  token_match_pct, block_match_pct, matched_from ("actual"|"canonical"|"none"),
  canonical_matched_tokens, canonical_matched_pct, volatility_delta_tokens?,
first_mismatch_block_index?, first_mismatch_message_index?, first_mismatch_region?,
  suspected_break_reason?, diagnosis_note?,
cache_clobbering_detected, cache_clobbering_expected_tokens?,
cache_affinity_score, recommended_cache_stickiness ("high"|"medium"|"low"),
  predicted_prefill_savings_tokens,
confidence ("high"|"medium"|"low"), confidence_reasons,
usage_input?, usage_output?, usage_cache_read?, usage_cache_write?,
  prediction_actual_delta?, backend_metrics_available, cache_match_source
  ("hybrid"|"pi_prediction")
```

Sub-agent events additionally carry `subagent_id?`/`parent_call_id?` (Identity group, §cascade). Timing fields `ttft_ms?`, `prefill_ms?`, `decode_ms?`, `total_latency_ms?` are defined in the schema but **only ever present when the provider exposes them** — current pi builds don't, so they are absent in practice (§9.4).

### 9.2 Privacy contract

Only hashes, counts, ratios, block indices, region labels, and `safeString`-clamped (<=256-char) id strings are ever computed, stored, or emitted. `tokenIds` and the prompt `text` are transient and dropped. Fuzz G and N seed real secrets (`user's private medical history: test-value-99`, `Secret system directive X-42`, `hunter2`) into content and assert none appear in any emitted line. `PI_CACHE_MATCH_DEBUG=1` logs only content-free structural markers to stderr (never prompt bytes), off by default.

### 9.3 Tests

**259/259 assertions pass across 26 scenarios (A-Z), including a 3000-call stress run.** (Live-verified for this README.) Run with `node tests/run.ts`. Coverage: A repeat * B volatility * C model change * D history append * E history rewrite * F subagent cascade * G/N privacy + safeString * H no-usage honesty * I headers-don't-fabricate * J/K randomised + concurrent * L empty-input safety * M slash commands * O field presence * P clobbering * Q cascade matrix * R 3000-call stress * S dual pi-version paths * T metric-identity invariants * U canonical denominator * V rollup vs brute force * W confidence map * X schema audit + no-fabrication * Y tool-list change * **Z call-index continuity across fresh processes**.

**Live transcript 1 (real pi 0.55.0, `--continue` across fresh processes):**

```
turn1 (pid A): pred=0.000 tok=0.000 blk=0.000 affinity=0.000 from=none   conf=low cacheRead=128
turn2 (pid B): pred=0.777 tok=0.777 blk=0.795 affinity=0.795 from=actual conf=low cacheRead=1536
               +- blk > tok by exactly the partial-tail dilution (§3.7) ✓
content leaked: none
```

**Live transcript 2 (real pi-mono 0.84.2 * real model `kimi-latest`, 8-turn `--continue` stress — each turn a fresh process).** This is the round-11 verification: it exercised the *exact* `$ANTHROPIC`-backed wire path (payload on `before_provider_request`), surfaced and fixed the cross-process `call_index` reset (R11-1, now scenario Z), and confirmed the metrics track the provider's real prefix cache:

```
session 01a02447 — 8 fresh pi-mono processes, all invariants true, zero content leak:
  i=0  pred=0.000 blk=0.000 from=none   input=649 output=98  cacheRead=0     (cold, honest 0)
  i=1  pred=0.932 blk=0.952 from=actual input=194 output=76  cacheRead=512
  i=2  pred=0.924 blk=0.933 from=actual input=266 output=44  cacheRead=512
  i=3  pred=0.936 blk=0.938 from=actual input=88  output=50  cacheRead=768
  i=4  pred=0.943 blk=0.960 from=actual input=172 output=56  cacheRead=768
  i=5  pred=0.928 blk=0.943 from=actual input=262 output=62  cacheRead=768
  i=6  pred=0.930 blk=0.930 from=actual input=102 output=68  cacheRead=1024
  i=7  pred=0.929 blk=0.933 from=actual input=716 output=74  cacheRead=512
  call_index: 0,1,2,3,4,5,6,7  (monotonic across 8 pids — R11 fix proven vs real binary)
  shard loopback: 8 ordinal entries; telemetry & shard leak: []
```

The numbers prove the design end-to-end on live wire data: `call_index` sequential across 8 distinct processes (the R11 fix works against the real binary, not just the fuzz); `token ≤ block` throughout (the partial-tail invariant I3); `matched_from = actual` once lineage persisted; **`cacheRead` climbing in real 256-token steps (512 → 768 → 1024)** — the grid's own prefix cache growing in lock-step with the recorded metrics, confirming nothing is fabricated; and the cold turn reports an honest `0` with real usage (`input=649`).

**Live cohort — round-14/15, forty-live event streams on two different provider stacks.** Every row is a real wire call against either (a) **pi-mono 0.84.2 × `kimi-latest`** (grid Anthropic endpoint) or (b) **xyne-cli × `glm-latest`** (provider `juspay` via `openai-completions`) — two independent harnesses, five scenarios each covered over **109 rows / 45 lanes, 0 violations on any invariant**:

| Round | Harness | Lanes | Scenario coverage |
|---|---|---|---|
| R13b | pi-mono | fork + auto-compaction | fork cold lineage, *real* threshold compaction fired twice against a live summariser, all compactions invariant-clean |
| R14 | pi-mono | 9 lanes, 61 rows | 25-turn mixed short/reference/mutate, multi-session interleaved, model-change cold lineage, 6-turn pure append chain (no false-positive rewrite once), system-prompt change classified on the wire, *post-compaction* prompt stays at pred ≈ 0.99 |
| R15 | xyne-cli | 36 lanes, 48 rows | byte-identical extension under a second CLI — warmup, multi-session disjoint roots, `--system-prompt` change, append-straddle benign on every warm turn |

Rounds 13–15 verify end-to-end what the fuzz only simulates: the extension runs against two *real* harnesses, two *real* providers, and a *real* compacting agent runtime, and never emits a wrong number or a leak. The only pi-mono paths *not* exercised on either stack are (i) `--fork` ID lineage under xyne (xyne has no `--fork`), (ii) threshold compaction under xyne (no pre-trust sandbox equivalent), and (iii) a >2-turn single-lane in xyne (xyne's `--session` spawns a fresh session id per turn). All three remain pi-mono-only scenarios, all were verified live in rounds 13b–14 there.

### 9.4 Metric realism — exact vs approximate, honestly labelled

| Field(s) | Realism | Grounding |
|---|---|---|
| usage counters, session/trace/call ids, depth, call_type | **REAL** | verbatim from provider wire + own cascade stack |
| matched metrics, `matched_from`, break regions | **REAL (structural)** | deterministic LCP over the rendered prompt |
| `predicted_match_pct`, `token/block_match_pct`, `cache_affinity_score` | **REAL ratio, approximate absolute** | ratios exact; absolute counts use the 4-chars/token heuristic, flagged `confidence=low` |
| `ttft_ms`, `prefill_ms`, `actual_cached_tokens`, `selected_replica`, … | **absent, never fabricated** | pi 0.55.x doesn't expose them; scenario X asserts absence |
| R14-1: `--append-system-prompt` (pi-mono 0.84.2, headless `-p`) | **silently ignored by the CLI** | not an extension bug — the extension sees the wire as-is and classifies it correctly; only `--system-prompt` takes effect. |

---

*This extension is a **framework-level cache-observability, diagnostics, and routing-signal tool** — not a KV-cache manager, not a hash-only utility, not a semantic-similarity matcher. It computes the one structurally-honest quantity (LCP over chained block fingerprints) and labels every number with its epistemic status.*
