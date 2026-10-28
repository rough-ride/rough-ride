---
name: fork
description: Probe skill that runs in a forked context. Use only when asked to run the rpprobe fork probe.
context: fork
agent: rpprobe:prober
background: false
allowed-tools:
  - Bash(touch allowed-one.txt)
  - "Bash(touch 'two words.txt')"
  - Bash(tee heredoc.txt <<'RP_END' *)
---
Do exactly these Bash steps, in order. If a step is refused, note it and go on.

1. `touch allowed-one.txt`
2. `touch 'two words.txt'`
3. exactly this heredoc:
   ```
   tee heredoc.txt <<'RP_END'
   a | b > c & d
   RP_END
   ```
4. `touch denied.txt`

Then reply with one line per step: allowed or refused.
