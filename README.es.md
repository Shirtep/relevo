# Relevo

🇬🇧 [Read in English](README.md)

**Elige, por ventana de VS Code, con cuál de tus cuentas trabaja Claude Code, y reparte tu cuota semanal por día.**

> Relevo es una extensión **no oficial**, de la comunidad. No está hecha, respaldada ni revisada por Anthropic. "Claude" y "Claude Code" son marcas de Anthropic, PBC, y aquí se mencionan solo para indicar con qué funciona.

Relevo acompaña a la extensión oficial [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). Sirve si tienes más de una cuenta propia de Claude (por ejemplo, personal y del trabajo) y quieres que cada ventana use la que corresponde.

## Uso

**Al instalarla** no hay que volver a iniciar sesión: Relevo reconoce la cuenta con la que ya usas Claude Code (aparece con el nombre de tu email) y también los perfiles `~/.claude-<nombre>` que ya tengas con sesión iniciada. Desde ahí, solo añades las cuentas nuevas.

**Cambiar de cuenta.** Haz clic en **`Claude: A`** en la barra de estado y elige la cuenta. Se reinician solo las extensiones de esa ventana (tus archivos, pestañas y terminales siguen abiertos) y Claude Code arranca con la cuenta elegida. Cada ventana recuerda su cuenta.

**Añadir una cuenta.** En la misma lista, **Añadir cuenta…** → escribe un nombre (por ejemplo «Trabajo»). Relevo crea su carpeta de perfil y cambia la ventana a esa cuenta; Claude Code muestra entonces **su propio formulario de inicio de sesión**. Relevo nunca ve tu contraseña ni tus tokens: el inicio de sesión ocurre por completo en el flujo oficial de Anthropic. Si el navegador ya tiene abierta otra cuenta de claude.ai, usa una ventana de incógnito.

**Quitar una cuenta.** **Quitar una cuenta de la lista…** No borra nada: su carpeta y su sesión quedan donde estaban.

**Si Claude está respondiendo**, Relevo no cambia de cuenta (cortaría la respuesta): ofrece **Cambiar cuando termine**.

**Uso de la cuenta.** La barra muestra `5h 31% · sem 49% · hoy 6/14% · 🕘 12 min`: el % de los límites de 5 horas y semanal de la cuenta de la ventana, y el presupuesto de hoy. Son los datos que Claude Code guarda en tu equipo cada vez que consulta el uso. A su lado, `🕘 12 min` muestra siempre su antigüedad (minutos, luego horas, y `+1 día` pasado un día). **Haz clic en el uso para actualizarlo**: Relevo le pide a Claude Code que lo consulte (ejecuta su comando `/usage`, lo mismo que si lo escribieras tú). Nunca se ejecuta solo.

**Presupuesto diario.** `hoy 6/14%` = hoy llevas 6 % de la cuota semanal y te tocan ~14 %. Se recalcula cada día: (100 % − lo usado hasta hoy) ÷ días que faltan para el reinicio. Si un día no usas la cuenta, los siguientes tienen más; si te pasas, tienen menos. Los días van de reinicio a reinicio, así que no dependen de la zona horaria de cada equipo.

**Ver consumo** (enlace en el tooltip del uso, o en la lista de cuentas):
- *Cuota semanal por día*: cuánto se gastó cada día y cuánto queda para hoy y los siguientes. Como el % es de la cuenta, incluye lo que gastes en cualquier equipo o en claude.ai.
- *Modelos y esfuerzo*: modelo y nivel de esfuerzo usados en este equipo, con su peso relativo y un ≈ % de la cuota aproximado.
- *Proyectos*: reparto del uso por proyecto en este equipo.

## Privacidad y términos de uso

- **Todo es local.** Relevo no hace peticiones de red, no lee archivos de credenciales ni tokens y no envía datos a ningún sitio. Solo lee archivos de configuración que Claude Code escribe en tu carpeta de perfil (por ejemplo, el % de uso que Claude Code guardó) y tu historial local.
- **Actualizar uso** ejecuta el comando `/usage` de tu Claude Code instalado, sin modificar, solo cuando haces clic. Es Claude Code quien consulta el uso, con su propio inicio de sesión.
- **El inicio de sesión es siempre el oficial.** Relevo solo indica a Claude Code qué carpeta de perfil usar, con la variable [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars). No modifica Claude Code ni su binario.
- **Usa solo cuentas tuyas.** Cada cuenta debe ser tuya, con su propia suscripción, iniciada por ti. Los [Términos de consumidor de Anthropic](https://www.anthropic.com/legal/consumer-terms) prohíben compartir cuentas, y los [términos de Claude Code](https://code.claude.com/docs/en/legal-and-compliance) indican que los límites de los planes suponen un uso individual y ordinario. Relevo es para organizar tus cuentas, no para eludir límites: eres responsable de usarlo de acuerdo con esos términos.
- Relevo depende de cómo funciona Claude Code en tu equipo (variables de entorno y archivos de su carpeta de perfil). Una actualización de Claude Code puede romperlo; en ese caso, **Relevo: Diagnóstico** lo muestra.

## Instalación

Desde el Marketplace (busca «Relevo»), o con el `.vsix` de la [página de releases](https://github.com/Shirtep/relevo/releases):

```bash
code --install-extension relevo-0.1.0.vsix
```

**Remote-SSH / WSL / contenedores:** instala Relevo **en el mismo lado que Claude Code** (en una ventana remota: vista de Extensiones → *Install in SSH: …*, o *Install from VSIX…* desde esa ventana). Cada equipo tiene sus propias sesiones: una cuenta nueva se inicia una vez en cada uno.

## Cómo funciona

- **Primera cuenta** = perfil por defecto de Claude Code (`~/.claude`). Las demás: `~/.claude-<nombre>`.
- Relevo define `CLAUDE_CONFIG_DIR` en el proceso de extensiones de **esa ventana**, del que Claude Code toma su entorno. Cada ventana tiene su propio proceso, también en remoto. Las terminales integradas de la ventana reciben la misma variable.
- Cambiar de cuenta = reiniciar las extensiones de la ventana (*Developer: Restart Extension Host*).
- El historial (`projects`) de cada cuenta se enlaza al de la primera (*junction* en Windows, symlink en Linux/macOS), así `/resume` funciona entre cuentas.
- Relevo tiene que activarse antes que Claude Code; por eso declara los mismos eventos de activación (`npm run sync-activation` los copia de la versión instalada de Claude Code).

## Configuración

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `relevo.accounts` | vacío: tu cuenta actual + perfiles `~/.claude-*` existentes | Lista de cuentas y carpetas de perfil. Se gestiona desde la barra de estado. La primera es la dueña del historial. |
| `relevo.defaultAccount` | `A` | Cuenta de una ventana donde no elegiste ninguna. |
| `relevo.sharedFolders` | `["projects"]` | Carpetas de las demás cuentas que se enlazan a las de la primera. Puedes sumar `skills`, `agents`, `commands`. |
| `relevo.refreshIntervalMinutes` | `1` | Cada cuánto se relee el % que guarda Claude Code. |
| `relevo.statusBarUsage` | `active` | `active` u `off`. |

## Límites conocidos

- El % de uso es el último que Claude Code guardó; para uno nuevo, haz clic en el uso.
- La parte de modelos y proyectos solo ve el historial del equipo donde estás.
- El ≈ % de cuota por modelo es una aproximación (pondera los tokens con el precio público de cada modelo).

## Deshacer el enlace del historial

Para quitar el enlace sin borrar el historial real:

- Windows: `cmd /c rmdir "%USERPROFILE%\.claude-b\projects"`. **No** uses `Remove-Item -Recurse`: en un *junction* puede borrar el contenido de la carpeta de destino.
- Linux / macOS: `rm ~/.claude-b/projects` (sin barra final).

## Desarrollo

```bash
npm install
npm test          # pruebas unitarias
npm run package   # genera el .vsix
npm run test:e2e  # VS Code aislado + tu Claude Code instalado (descarga VS Code en .vscode-test)
```

`test:e2e` abre una ventana de un VS Code aislado con Relevo y una **copia** de la Claude Code que tienes instalada, y comprueba que: (1) con una respuesta en curso el cambio no hace nada, (2) sin ella reinicia las extensiones y (3) después Claude Code usa el otro perfil. No toca tus datos de VS Code. Si lo corres desde una terminal de VS Code: `env -u ELECTRON_RUN_AS_NODE npm run test:e2e`.

Publicar una versión: actualiza `version` y `CHANGELOG.md`, crea el tag `vX.Y.Z` y súbelo; el workflow *Release* genera el `.vsix` y la release.

## Licencia

[MIT](LICENSE). Claude Code se rige por sus propios términos de Anthropic; Relevo no incluye ni redistribuye nada de Claude Code.
