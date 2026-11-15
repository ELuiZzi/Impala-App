#!/usr/bin/env bash
# Preparación única del servidor para Impala. Requiere sudo:
#   sudo bash setup-servidor.sh
set -euo pipefail

U="${SUDO_USER:?Ejecuta este script con sudo}"

echo "==> Creando /srv/music y /srv/impala (propietario: $U)"
mkdir -p /srv/music /srv/impala/navidrome
chown "$U:$U" /srv/music /srv/impala /srv/impala/navidrome

echo "==> Añadiendo $U al grupo docker"
usermod -aG docker "$U"

echo "==> Permitiendo que $U gestione 'tailscale serve' sin sudo"
tailscale set --operator="$U"

echo "==> Listo. Cierra y vuelve a abrir la sesión SSH para que aplique el grupo docker."
