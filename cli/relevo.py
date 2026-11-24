#!/usr/bin/env python3
"""relevo (terminal): elige con qué cuenta de Claude Code trabaja ESTA terminal.

Es el mismo mecanismo que la extensión de VS Code: cada cuenta es una carpeta de perfil
(~/.claude = la primera, ~/.claude-<nombre> = las demás) y Claude Code usa la que indique la
variable CLAUDE_CONFIG_DIR. relevo la define solo para el `claude` que lanza, así que cada
terminal puede gastar de una cuenta distinta a la vez.

Uso:
  relevo                 menú: muestra el uso de cada cuenta y lanza claude con la elegida
  relevo <cuenta> [...]  lanza claude con esa cuenta; lo demás se le pasa a claude
                         (p. ej. `relevo b --continue` sigue la última conversación con la cuenta b)
  relevo uso             solo muestra el uso de las cuentas
  relevo nueva <nombre>  crea ~/.claude-<nombre> (historial compartido) y abre claude para iniciar sesión
  relevo cual            dice qué cuenta usa esta terminal

El uso (5 h / semana) se consulta con la sesión de cada cuenta, igual que el panel Super+S;
si no hay red, se muestra el último dato que guardó Claude Code.
"""
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

HOME = Path.home()
PRINCIPAL = HOME / ".claude"
COMPARTIDAS = ["projects"]  # carpetas que las demás cuentas enlazan a las de la principal
USO_URL = "https://api.anthropic.com/api/oauth/usage"

# Colores (se apagan si la salida no es una terminal o con NO_COLOR)
_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def c(txt, cod):
    return f"\033[{cod}m{txt}\033[0m" if _COLOR else str(txt)


def verde(t): return c(t, "32")
def amarillo(t): return c(t, "33")
def rojo(t): return c(t, "31")
def gris(t): return c(t, "90")
def negrita(t): return c(t, "1")


class Cuenta:
    def __init__(self, nombre, carpeta):
        self.nombre = nombre
        self.carpeta = carpeta
        self.es_principal = carpeta == PRINCIPAL
        # La principal guarda su config global fuera de la carpeta (~/.claude.json)
        self.config = HOME / ".claude.json" if self.es_principal else carpeta / ".claude.json"
        self.uso = None      # dict con five_hour / seven_day
        self.fuente = ""     # "ahora" | "guardado hace X" | mensaje de error

    def leer_json(self, f):
        try:
            return json.loads(Path(f).read_text())
        except Exception:
            return {}

    @property
    def correo(self):
        return (self.leer_json(self.config).get("oauthAccount") or {}).get("emailAddress")

    @property
    def con_sesion(self):
        return (self.carpeta / ".credentials.json").exists()

    def entorno(self):
        env = dict(os.environ)
        if self.es_principal:
            env.pop("CLAUDE_CONFIG_DIR", None)
        else:
            env["CLAUDE_CONFIG_DIR"] = str(self.carpeta)
        env["RELEVO_CUENTA"] = self.nombre
        return env

    def consultar_uso(self):
        try:
            cred = self.leer_json(self.carpeta / ".credentials.json").get("claudeAiOauth") or {}
            if not cred.get("accessToken"):
                raise RuntimeError("sin sesión")
            if cred.get("expiresAt", 0) / 1000 < time.time():
                raise RuntimeError("sesión caducada (se renueva al abrir claude con esta cuenta)")
            req = urllib.request.Request(USO_URL, headers={
                "Authorization": "Bearer " + cred["accessToken"],
                "anthropic-beta": "oauth-2025-04-20", "User-Agent": "relevo-cli"})
            with urllib.request.urlopen(req, timeout=6) as r:
                self.uso = json.load(r)
                self.fuente = "ahora"
        except Exception as e:
            motivo = str(e) if isinstance(e, RuntimeError) else "sin conexión"
            cache = self.leer_json(self.config).get("cachedUsageUtilization") or {}
            if cache.get("utilization"):
                self.uso = cache["utilization"]
                mins = int((time.time() * 1000 - cache.get("fetchedAtMs", 0)) / 60000)
                self.fuente = f"{motivo}; dato guardado hace {hace(mins)}"
            else:
                self.fuente = motivo

    def pct(self, clave):
        d = (self.uso or {}).get(clave) or {}
        u = d.get("utilization")
        if u is None:
            return None, None
        try:
            reinicio = datetime.fromisoformat(d["resets_at"]).astimezone()
        except Exception:
            reinicio = None
        # Si la ventana ya se reinició, el número guardado ya no vale
        if reinicio and reinicio < datetime.now().astimezone():
            return 0, None
        return u, reinicio


def hace(mins):
    if mins < 60:
        return f"{mins} min"
    if mins < 60 * 24:
        return f"{mins // 60} h"
    return f"{mins // (60 * 24)} días"


def descubrir():
    """~/.claude primero (cuenta "a"), luego cada ~/.claude-<nombre> con su nombre."""
    cuentas = [Cuenta("a", PRINCIPAL)]
    for d in sorted(HOME.glob(".claude-*")):
        if d.is_dir() and not d.is_symlink():
            cuentas.append(Cuenta(d.name[len(".claude-"):], d))
    return cuentas


def buscar(cuentas, nombre):
    nombre = nombre.lower()
    for ct in cuentas:
        if ct.nombre.lower() == nombre or (ct.correo or "").lower().split("@")[0] == nombre:
            return ct
    return None


def color_pct(u):
    txt = f"{u:3.0f} %"
    return rojo(txt) if u >= 80 else amarillo(txt) if u >= 50 else verde(txt)


def barra(u, ancho=10):
    llenos = round(u / 100 * ancho)
    return "█" * llenos + gris("░" * (ancho - llenos))


def reinicio_txt(r, corto):
    if not r:
        return ""
    if corto:
        m = int((r - datetime.now().astimezone()).total_seconds() // 60)
        return f"reinicia en {m // 60} h {m % 60:02d} min" if m >= 60 else f"reinicia en {max(m, 0)} min"
    dias = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    return f"reinicia {dias[r.weekday()]} {r:%H:%M}"


def consultar_todas(cuentas):
    hilos = [threading.Thread(target=ct.consultar_uso) for ct in cuentas]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()


def puntaje(ct):
    """Cuanto menor, más libre está la cuenta (para la recomendación)."""
    cinco, _ = ct.pct("five_hour")
    semana, _ = ct.pct("seven_day")
    if cinco is None and semana is None:
        return 1000
    return max(cinco or 0, semana or 0)


def actual():
    """Cuenta que usaría `claude` en esta terminal."""
    dir_ = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(dir_).expanduser().resolve() if dir_ else PRINCIPAL


def mostrar(cuentas, numerar=False, recomendada=None):
    aqui = actual()
    for i, ct in enumerate(cuentas, 1):
        quien = ct.correo or gris("(sin sesión)")
        marca = []
        if ct is recomendada:
            marca.append(verde("← recomendada"))
        if ct.carpeta.resolve() == aqui:
            marca.append(gris("(la de esta terminal)"))
        pre = f"  {negrita(str(i))})" if numerar else "  •"
        print(f"{pre} {negrita(ct.nombre)}  {quien}  {' '.join(marca)}")
        for clave, txt, corto in (("five_hour", "5 h   ", True), ("seven_day", "semana", False)):
            u, r = ct.pct(clave)
            if u is None:
                continue
            print(f"       {txt} {barra(u)} {color_pct(u)}  {gris(reinicio_txt(r, corto))}")
        if ct.fuente != "ahora":
            print(f"       {gris(ct.fuente)}")
        print()


def asegurar_compartidas(ct):
    """Las cuentas secundarias enlazan su historial al de la principal (para /resume entre cuentas)."""
    if ct.es_principal:
        return
    for nombre in COMPARTIDAS:
        destino = PRINCIPAL / nombre
        enlace = ct.carpeta / nombre
        if enlace.is_symlink() or not destino.exists():
            continue
        if enlace.exists():
            print(amarillo(f"Aviso: {enlace} es una carpeta propia, no el historial compartido; la dejo como está."))
            continue
        enlace.symlink_to(destino)


def lanzar(ct, args):
    exe = shutil.which("claude")
    if not exe:
        sys.exit(rojo("No encuentro el comando `claude`."))
    asegurar_compartidas(ct)
    print(gris(f"→ claude con la cuenta {ct.nombre} ({ct.correo or 'sin sesión: te pedirá iniciarla'})"), flush=True)
    os.execve(exe, [exe, *args], ct.entorno())


def menu(cuentas, args):
    print(gris("Consultando uso…"), end="\r", flush=True)
    consultar_todas(cuentas)
    print(" " * 30, end="\r")
    rec = min(cuentas, key=puntaje)
    mostrar(cuentas, numerar=True, recomendada=rec)
    try:
        r = input(f"Cuenta [1-{len(cuentas)}, Enter = {rec.nombre}, q = salir]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return
    if r.lower() in ("q", "salir"):
        return
    if not r:
        ct = rec
    elif r.isdigit() and 1 <= int(r) <= len(cuentas):
        ct = cuentas[int(r) - 1]
    else:
        ct = buscar(cuentas, r)
        if not ct:
            sys.exit(rojo(f"No hay ninguna cuenta «{r}»."))
    lanzar(ct, args)


def main():
    cuentas = descubrir()
    a = sys.argv[1:]
    if not a or a[0].startswith("-") and a[0] not in ("-h", "--help"):
        return menu(cuentas, a)  # `relevo --continue` → menú y luego claude --continue
    cmd, resto = a[0], a[1:]
    if cmd in ("-h", "--help", "ayuda"):
        print(__doc__)
    elif cmd == "uso":
        consultar_todas(cuentas)
        mostrar(cuentas)
    elif cmd == "cual":
        aqui = actual()
        ct = next((x for x in cuentas if x.carpeta.resolve() == aqui), None)
        print(f"{ct.nombre} ({ct.correo})" if ct else f"perfil {aqui}")
    elif cmd == "nueva":
        if not resto or not resto[0].isalnum():
            sys.exit("Uso: relevo nueva <nombre>   (solo letras y números, p. ej. «trabajo»)")
        carpeta = HOME / f".claude-{resto[0].lower()}"
        if carpeta.exists():
            sys.exit(f"Ya existe {carpeta}; úsala con: relevo {resto[0].lower()}")
        carpeta.mkdir()
        print(f"Creada {carpeta}. Claude Code te pedirá iniciar sesión con la cuenta nueva "
              "(si el navegador ya tiene otra cuenta abierta, usa una ventana de incógnito).")
        lanzar(Cuenta(resto[0].lower(), carpeta), resto[1:])
    else:
        ct = buscar(cuentas, cmd)
        if not ct:
            nombres = ", ".join(x.nombre for x in cuentas)
            sys.exit(rojo(f"No hay ninguna cuenta «{cmd}». Cuentas: {nombres}"))
        lanzar(ct, resto)


if __name__ == "__main__":
    main()
