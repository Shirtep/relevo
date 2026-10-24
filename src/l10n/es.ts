/** Spanish translations, keyed by the English source text. Checked by the unit tests. */
export const es: Record<string, string> = {
  // status bar & tooltip
  'Claude: account': 'Claude: cuenta',
  'Claude: account {0}': 'Claude: cuenta {0}',
  'Claude: usage': 'Claude: uso',
  'Claude: now using the account {0}': 'Claude: ahora usas la cuenta {0}',
  'This window uses the account {0}': 'Esta ventana usa la cuenta {0}',
  Usage: 'Uso',
  Resets: 'Se reinicia',
  '5 hours': '5 horas',
  Weekly: 'Semanal',
  wk: 'sem',
  today: 'hoy',
  'when done': 'al terminar',
  'Source: {0}.': 'Fuente: {0}.',
  'Click the usage to refresh it.': 'Haz clic en el uso para actualizarlo.',
  "Claude Code has not stored this account's usage yet": 'Claude Code todavía no guardó el uso de esta cuenta',
  'figures Claude Code stored {0} ago': 'dato que guardó Claude Code hace {0}',
  'figures Claude Code stored more than a day ago': 'dato que guardó Claude Code hace más de un día',
  '{0} min': '{0} min',
  '{0} h': '{0} h',
  '+1 day': '+1 día',
  'Switch account': 'Cambiar cuenta',
  'Usage panel': 'Ver consumo',
  'Refresh usage': 'Actualizar uso',
  'Report a problem': 'Reportar un problema',
  'Report a problem…': 'Reportar un problema…',
  'Restart extensions': 'Reiniciar extensiones',
  'The account settings changed.': 'Cambió la configuración de cuentas.',
  'Claude Code in this window started with the account {0}.': 'Claude Code en esta ventana arrancó con la cuenta {0}.',
  'Claude Code confirmed the account {0} in this window.': 'Claude Code confirmó la cuenta {0} en esta ventana.',

  // daily budget
  "Today's budget: ~{0}% of the weekly quota ({1}% free for {2}, until {3}).":
    'Presupuesto de hoy: ~{0}% de la cuota semanal ({1}% libre para {2}, hasta el {3}).',
  'Today you have used {0}% and have ~{1}% left.': 'Hoy llevas {0}% y te quedan ~{1}%.',
  'Today you have used {0}%, ~{1}% over: the remaining days will get less.': 'Hoy llevas {0}%, ~{1}% por encima: los días que quedan tendrán menos.',
  'Recording started partway through this day, so earlier use is not counted.': 'El registro empezó a mitad de este día, así que lo usado antes no cuenta.',
  'The quota day ends {0}.': 'El día de cuota termina {0}.',
  'the last day': 'el último día',
  '{0} days': '{0} días',

  // problems & warnings
  'the local machine': 'el equipo local',
  'the remote ({0})': 'el remoto ({0})',
  'The Claude Code extension (anthropic.claude-code) was not found on this host.':
    'No encontré la extensión Claude Code (anthropic.claude-code) en este host.',
  'Claude Code runs on {0} and Relevo on {1}: install Relevo on the same side as Claude Code so it can choose the account.':
    'Claude Code corre en {0} y Relevo en {1}: instala Relevo en el mismo lado que Claude Code para que pueda elegir la cuenta.',
  'claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR, which overrides the account of each window.':
    'claudeCode.environmentVariables define CLAUDE_CONFIG_DIR, y eso tiene prioridad sobre la cuenta de cada ventana.',
  'Claude Code started with the account {0} in this window, not {1}.': 'Claude Code arrancó con la cuenta {0} en esta ventana, no con {1}.',
  'Relevo: something went wrong ({0}).': 'Relevo: algo falló ({0}).',
  'Claude Code did not update the usage. Try typing /usage in Claude Code.': 'Claude Code no actualizó el uso. Prueba escribiendo /usage en Claude Code.',
  'The account settings changed. Restart the extensions so Claude Code uses the account {0}.':
    'La configuración de cuentas cambió. Reinicia las extensiones para que Claude Code use la cuenta {0}.',

  // account picker & switching
  'Claude account for this window': 'Cuenta de Claude para esta ventana',
  "Picking another account restarts this window's extensions; your files and terminals stay open":
    'Al elegir otra cuenta se reinician las extensiones de esta ventana; tus archivos y terminales no se cierran',
  'Cancel the switch to {0}': 'Cancelar el cambio a {0}',
  'Claude is still answering': 'Claude sigue respondiendo',
  'not signed in: Claude Code will ask you to sign in': 'sin sesión: Claude Code te pedirá iniciarla',
  'In use in this window': 'En uso en esta ventana',
  'Add account…': 'Añadir cuenta…',
  'Remove an account from the list…': 'Quitar una cuenta de la lista…',
  'Claude is answering in this window. Switching to {0} now would cut the answer short.':
    'Claude está respondiendo en esta ventana. Si cambias a {0} ahora, se cortaría la respuesta.',
  'Switch when it finishes': 'Cambiar cuando termine',
  Cancel: 'Cancelar',
  'Could not restart the extensions. Reload the window to use the other account.': 'No se pudo reiniciar las extensiones. Recarga la ventana para usar la otra cuenta.',
  'Reload window': 'Recargar ventana',
  'The account "{0}" is not signed in yet. Claude Code will show its sign-in form: open the link, authorize with that claude.ai account and paste the code here if asked. If your browser is signed in to another account, use a private window.':
    'La cuenta «{0}» todavía no tiene sesión. Claude Code te mostrará su formulario de inicio de sesión: abre el enlace, autoriza con esa cuenta de claude.ai y pega aquí el código si te lo pide. Si tu navegador tiene abierta otra cuenta, usa una ventana de incógnito.',
  'Open Claude': 'Abrir Claude',

  // adding & removing accounts
  'Add a Claude account': 'Añadir cuenta de Claude',
  'A name to recognize it, e.g. "Work". When you pick it, Claude Code will ask you to sign in.':
    'Un nombre para reconocerla, por ejemplo «Trabajo». Al elegirla, Claude Code te pedirá iniciar sesión.',
  Work: 'Trabajo',
  'Type a name.': 'Escribe un nombre.',
  'An account with that name already exists.': 'Ya hay una cuenta con ese nombre.',
  'Use at least one letter or number.': 'Usa al menos una letra o un número.',
  'There are no accounts to remove: the first one and the one this window uses stay.': 'No hay cuentas que quitar: la primera y la que usa esta ventana se quedan.',
  'Remove an account from the list': 'Quitar una cuenta de la lista',
  'Pick the account to remove': 'Elige la cuenta que quieres quitar',
  'Remove the account "{0}" from the list?': '¿Quitar la cuenta «{0}» de la lista?',
  'Nothing is deleted: its folder ({0}) and sign-in stay there. Add it again with the same name to get everything back.':
    'No se borra nada: su carpeta ({0}) y su sesión siguen ahí. Si la vuelves a añadir con el mismo nombre, recuperas todo.',
  Remove: 'Quitar',

  // profiles
  '{0} already has content.': '{0} ya tiene contenido.',
  'Move it to {0} and leave a link, so both accounts share history? If a file exists in both, both are kept.':
    '¿Lo muevo a {0} y dejo un enlace, para que ambas cuentas compartan historial? Si un archivo ya existe en los dos, se conservan ambos.',
  'Merge and link': 'Fusionar y enlazar',
  'Continue without linking': 'Seguir sin enlazar',
  "{0} doesn't point to {1}; left untouched.": '{0} no apunta a {1}; no lo toqué.',
  'Could not prepare the profile {0}: {1}': 'No se pudo preparar el perfil {0}: {1}',

  // problem reports
  'Problem report ready. Add what happened at the top, then save or copy it and send it. Emails, user and machine names and folder paths are masked.':
    'Reporte listo. Escribe arriba qué pasó y luego guárdalo o cópialo y envíalo. Los correos, nombres de usuario y de equipo y las rutas de carpetas están ocultos.',
  'Save…': 'Guardar…',
  Copy: 'Copiar',

  // usage panel
  'Claude usage': 'Consumo de Claude',
  'Reading history…': 'Leyendo historial…',
  'Account {0}{1} · updated {2}': 'Cuenta {0}{1} · actualizado {2}',
  "Claude Code checks the account's usage (its /usage command)": 'Claude Code consulta el uso de la cuenta (su comando /usage)',
  'Could not read the history: {0}': 'No se pudo leer el historial: {0}',
  'Weekly quota per day': 'Cuota semanal por día',
  Used: 'Usado',
  'Available to stay on pace': 'Disponible para seguir el ritmo',
  "Measured from the account's usage as stored by Claude Code, so it includes use from any machine or claude.ai.":
    'Medido con el % de la cuenta que guarda Claude Code, así que incluye lo que gastes en cualquier equipo o en claude.ai.',
  'Each day ends at the weekly reset time ({0}).': 'Cada día termina a la hora del reinicio semanal ({0}).',
  'Recorded since {0}, each time Claude Code updates it on this machine.': 'Registrado desde {0}, cada vez que Claude Code actualiza ese dato en este equipo.',
  'No recording yet.': 'Aún no hay registro.',
  Account: 'Cuenta',
  '{0} (this window)': '{0} (esta ventana)',
  'All accounts': 'Todas las cuentas',
  'On this machine · last {0} days': 'En este equipo · últimos {0} días',
  'No activity for that account on this machine.': 'Sin actividad de esa cuenta en este equipo.',
  Projects: 'Proyectos',
  '{0} files read in {1} ms.': '{0} archivos leídos en {1} ms.',
  '"Relative use" weighs tokens with each model\'s API price (cache reads at 0.1×, writes at 1.25–2×): it is for comparing, not a cost.':
    '«Uso relativo» pondera los tokens con el precio de cada modelo en la API (lectura de caché a 0,1×, escritura a 1,25–2×): sirve para comparar, no es un costo.',
  "This section only sees this machine's history; use on other machines does not show here.":
    'Esta parte solo ve el historial de este equipo; lo que hagas en otro equipo no aparece aquí.',
  'Account limits': 'Límites de la cuenta',
  'Claude Code has not stored this account\'s usage yet. Click "Refresh usage".': 'Claude Code todavía no guardó el uso de esta cuenta. Pulsa «Actualizar uso».',
  'Figures Claude Code stored {0}.': 'Dato que guardó Claude Code {0}.',
  'Click "Refresh usage" to ask Claude Code for new ones.': 'Pulsa «Actualizar uso» para pedirle a Claude Code uno nuevo.',
  "Today's budget": 'Presupuesto de hoy',
  "over today's share": 'por encima de lo de hoy',
  'free of ~{0} for today': 'libre de ~{0} para hoy',
  'Used today': 'Usado hoy',
  Today: 'Hoy',
  '{0} of the quota free for {1} (reset {2}).': '{0} de la cuota libre para {1} (reinicio {2}).',
  'Use less one day and the next ones get more; use more and they get less.': 'Si un día usas menos, los siguientes tienen más; si usas más, tienen menos.',
  'Recording started partway through this day: earlier use is not counted.': 'El registro empezó a mitad de este día: lo usado antes no cuenta.',
  'resets {0}': 'reinicia {0}',
  'today {0}': 'hoy {0}',
  'tomorrow {0}': 'mañana {0}',
  'just now': 'hace un momento',
  '{0} min ago': 'hace {0} min',
  '{0} h ago': 'hace {0} h',
  '{0} days ago': 'hace {0} días',
  Model: 'Modelo',
  Effort: 'Esfuerzo',
  Responses: 'Respuestas',
  'Relative use': 'Uso relativo',
  '≈ weekly quota': '≈ cuota semanal',
  'Models and effort': 'Modelos y esfuerzo',
  '"≈ weekly quota" splits the {0} the account used in these 7 days by each row\'s relative use.':
    '«≈ cuota semanal» reparte el {0} que la cuenta gastó en estos 7 días según el uso relativo de cada fila.',
  'It assumes it all came from this machine: if you also use the account elsewhere, it overestimates here.':
    'Supone que todo salió de este equipo: si también usas la cuenta en otro, aquí sobreestima.',
  low: 'bajo',
  medium: 'medio',
  high: 'alto',
  'extra high': 'muy alto',
  max: 'máximo',
  unknown: 'sin dato',
  'Weekly quota used and available per day': 'Cuota semanal usada y disponible por día',
  '{0} of {1}': '{0} de {1}',
  'not recorded': 'sin registro',
  'used (partial recording)': 'usado (registro parcial)',
  used: 'usado',
  'left today': 'te queda hoy',
  'available that day': 'disponible ese día',
  'Others ({0})': 'Otros ({0})',
  Unidentified: 'Sin identificar',
};
