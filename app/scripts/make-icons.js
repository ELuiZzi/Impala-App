// Genera los íconos de Impala: una nota musical blanca cuya plica es un rayo, sobre fondo morado.
// Uso: node make-icons.js <carpeta-destino>
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) throw new Error('Falta la carpeta de destino');
fs.mkdirSync(out, { recursive: true });

const PURPLE = '#A235FA';

// Trazo original en un lienzo de 1450 px; su centro óptico está en (731, 721).
const NOTE = `
  M965 205 C980 188 1010 196 1002 222 L898 478 C891 497 900 512 920 512 L1060 512
  C1095 512 1105 550 1078 576 C960 690 820 860 760 1070 C735 1160 660 1235 540 1245
  C430 1255 360 1200 357 1120 C355 1030 460 935 600 925 C640 922 665 930 685 937
  C698 941 712 932 718 918 L815 678 C823 657 812 645 795 645 L652 645
  C620 645 610 610 632 585 Z`;

const defs = `
  <defs>
    <filter id="sombra" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#5a0fa8" flood-opacity="0.45"/>
    </filter>
  </defs>`;

/**
 * Nota centrada en un lienzo de 1024 px. `scale` = 1 equivale al tamaño del diseño original, donde
 * el fondo redondeado ocupa todo el lienzo; los íconos adaptativos la encogen a su zona visible.
 */
function note(color, scale = 1, shadow = true) {
  const k = (1024 / 1450) * scale;
  return `<g transform="translate(512 512) scale(${k}) translate(-731 -721)">
    <path d="${NOTE}" fill="${color}" ${shadow ? 'filter="url(#sombra)"' : ''}/>
  </g>`;
}

const svg = (body, background = null) => `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${defs}
  ${background ? `<rect width="1024" height="1024" fill="${background}"/>` : ''}
  ${body}
</svg>`;

// En los íconos adaptativos solo se ve el 66,7 % central (72 de 108 dp): la nota se escala a esa zona.
const ADAPTIVE = 0.667;

const files = {
  // Ícono "clásico" (y base de la tienda): fondo completo + nota; el lanzador recorta las esquinas.
  'icon.png': svg(note('#FFFFFF'), PURPLE),
  // Ícono adaptativo de Android: capas separadas.
  'android-icon-background.png': svg('', PURPLE),
  'android-icon-foreground.png': svg(note('#FFFFFF', ADAPTIVE)),
  'android-icon-monochrome.png': svg(note('#FFFFFF', ADAPTIVE, false)),
  // Pantalla de carga: la nota morada sobre fondo transparente (blanco/negro según el tema).
  'splash-icon.png': svg(note(PURPLE, 1.1, false)),
  'favicon.png': svg(note('#FFFFFF'), PURPLE),
};

for (const [name, content] of Object.entries(files)) {
  const size = name === 'favicon.png' ? 48 : 1024;
  const png = new Resvg(content, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(out, name), png);
  console.log(`${name}: ${png.length} bytes`);
}
