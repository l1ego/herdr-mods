# herdr agent-resume, sourced at the end of ~/.bashrc or ~/.zshrc.
#
# hook.py records the agent session each Herdr app terminal runs. When a terminal comes back
# without it (a reboot, a lost herdr-core), herdr-core gives it a fresh shell: this resumes the
# session there, as the herdr TUI does. Back at a prompt, the agent has ended: its record goes.
# HERDR_AGENT_RESUME=off turns resuming off; records are still kept.

if [ -n "${HC_TERMINAL_ID:-}" ] && [ -n "${PS1:-}" ]; then
  __herdr_resume_hook="${BASH_SOURCE[0]:-${(%):-%x}}"
  __herdr_resume_hook="${__herdr_resume_hook%/*}/hook.py"
  __herdr_resume_file="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-resume/${HC_TERMINAL_ID//[^A-Za-z0-9_.-]/_}"

  # Whether the process recorded as boot:pid:start still runs.
  __herdr_resume_alive() {
    local boot pid start stat
    read -r boot 2>/dev/null < /proc/sys/kernel/random/boot_id || return 1
    case $1 in "$boot":*) ;; *) return 1 ;; esac
    pid=${1#"$boot":}
    start=${pid#*:}
    pid=${pid%%:*}
    read -r stat 2>/dev/null < "/proc/$pid/stat" || return 1
    [ "$(printf '%s\n' "${stat##*) }" | cut -d' ' -f20)" = "$start" ]
  }

  # hc from PATH, else beside herdr-core (the terminal's shell is its child).
  __herdr_resume_hcbin() {
    if command -v hc >/dev/null 2>&1; then
      command -v hc
    else
      local core
      core=$(readlink "/proc/$PPID/exe" 2>/dev/null) && [ -x "${core%/*}/hc" ] && printf '%s\n' "${core%/*}/hc"
    fi
  }
  __herdr_resume_hc() {
    local bin
    bin=$(__herdr_resume_hcbin) && "$bin" "$@"
  }

  __herdr_resume_forget() {
    rm -f "$__herdr_resume_file"
    __herdr_resume_hc label "$HC_TERMINAL_ID" resume= >/dev/null 2>&1
  }

  # Before each prompt: an agent recorded here that no longer runs has ended.
  __herdr_resume_prompt() {
    local rc=$?
    if [ -f "$__herdr_resume_file" ]; then
      local herdr_resume_proc= herdr_resume_created= herdr_resume_cwd= herdr_resume_cmd= herdr_resume_time=
      . "$__herdr_resume_file"
      __herdr_resume_alive "$herdr_resume_proc" || __herdr_resume_forget
    fi
    return $rc
  }

  # Once, as the shell starts: resume what this terminal ran before it was lost.
  __herdr_resume_start() {
    [ -f "$__herdr_resume_file" ] || return 0
    local herdr_resume_proc= herdr_resume_created= herdr_resume_cwd= herdr_resume_cmd= herdr_resume_time= parent created
    . "$__herdr_resume_file"
    __herdr_resume_alive "$herdr_resume_proc" && return 0
    # Only the terminal's own shell, not one started inside it.
    read -r parent 2>/dev/null < "/proc/$PPID/comm"
    [ "$parent" = herdr-core ] || return 0
    [ "${HERDR_AGENT_RESUME:-}" = off ] && return 0
    # The same terminal, not a new one that got its address.
    created=$(__herdr_resume_hc get "$HC_TERMINAL_ID" --json 2>/dev/null | grep -o '"created_ms": *[0-9]*' | grep -o '[0-9]*$')
    if [ -z "$created" ] || [ "$created" != "$herdr_resume_created" ] || [ -z "$herdr_resume_cmd" ]; then
      __herdr_resume_forget
      return 0
    fi
    [ -d "$herdr_resume_cwd" ] && [ "$PWD" != "$herdr_resume_cwd" ] && cd -- "$herdr_resume_cwd"
    printf '\033[2mherdr: resuming the agent this terminal ran\033[0m\n'
    # Typed at the prompt by herdr-core, as if by hand, once the shell is ready: run from here the
    # agent would share the shell's process group, so Herdr and Ctrl+Z wouldn't see it as a job.
    # Without HC_TERMINAL_ID, hc sends it as is, not as a note from this terminal.
    local bin boot stat
    bin=$(__herdr_resume_hcbin) || return 0
    # Until the agent runs, the record names this shell, so the first prompt keeps it; hook.py
    # adopt then names the agent (Codex reports its session only with its first message).
    read -r boot 2>/dev/null < /proc/sys/kernel/random/boot_id
    read -r stat 2>/dev/null < "/proc/$$/stat"
    stat=$(printf '%s\n' "${stat##*) }" | cut -d' ' -f20)
    sed -i "s|^herdr_resume_proc=.*|herdr_resume_proc=$boot:$$:$stat|" "$__herdr_resume_file"
    (python3 -I "${__herdr_resume_hook}" adopt "$HC_TERMINAL_ID" "$$" >/dev/null 2>&1 &)
    (env -u HC_TERMINAL_ID -u HC_SCOPE "$bin" send "$HC_TERMINAL_ID" "$herdr_resume_cmd" >/dev/null 2>&1 &)
  }

  if [ -n "${ZSH_VERSION:-}" ]; then
    precmd_functions+=(__herdr_resume_prompt)
  else
    PROMPT_COMMAND="__herdr_resume_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
  __herdr_resume_start
fi
