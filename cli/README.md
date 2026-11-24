# relevo (terminal)

Versión de terminal de Relevo para **Claude Code en la terminal** (la extensión solo sirve en VS Code).
Cada terminal elige con qué cuenta trabaja, así puedes tener terminales gastando de cuentas distintas a la vez.

Instalación: `ln -s "$PWD/cli/relevo.py" ~/.local/bin/relevo`

| Comando | Qué hace |
|---|---|
| `relevo` | Muestra el uso (5 h / semana) de cada cuenta, recomienda la más libre y abre `claude` con la que elijas |
| `relevo b` | Abre `claude` con la cuenta `b` directamente (`relevo a` = la principal, `~/.claude`) |
| `relevo b --continue` | Lo que va detrás se le pasa a `claude`: aquí sigue la última conversación, pero con la cuenta `b` |
| `relevo uso` | Solo muestra el uso |
| `relevo cual` | Qué cuenta usa esta terminal |
| `relevo nueva <nombre>` | Crea `~/.claude-<nombre>` con el historial compartido y abre `claude` para iniciar sesión |

Cómo funciona: igual que la extensión. Define `CLAUDE_CONFIG_DIR` solo para el `claude` que lanza
(`~/.claude` = cuenta `a`; `~/.claude-<nombre>` = las demás) y enlaza `projects` de cada cuenta al de la
principal, así `/resume` y `--continue` funcionan entre cuentas. Un `claude` normal sigue usando la cuenta `a`.

Una conversación abierta no puede cambiar de cuenta en caliente: sal (`/exit`) y vuelve a entrar con
`relevo <otra> --continue`.

Privacidad: a diferencia de la extensión, para mostrar el uso al momento lee el token de sesión de cada cuenta
(`.credentials.json`) y consulta el endpoint de uso de Anthropic. Sin conexión o con la sesión caducada, usa el dato que guardó Claude Code.
