/*
 * forest-art.js — original flat-vector SVG tree art for the Focus (forest) page.
 * Exposes window.ForestArt = { SPECIES, treeSVG(speciesId, stage, opts), tileSVG(trees, opts) }.
 * Pure string builders; no DOM access. All artwork is original.
 */
(function () {
  'use strict';

  var SPECIES = [
    { id: 'oak',    name: 'Oak',            price: 0 },
    { id: 'pine',   name: 'Pine',           price: 60 },
    { id: 'cherry', name: 'Cherry Blossom', price: 120 },
    { id: 'lemon',  name: 'Lemon Tree',     price: 180 },
    { id: 'willow', name: 'Willow',         price: 260 },
    { id: 'cactus', name: 'Cactus',         price: 340 },
    { id: 'maple',  name: 'Autumn Maple',   price: 450 },
    { id: 'baobab', name: 'Baobab',         price: 600 },
  ];

  var SOIL_DARK = '#5C3A0E', SOIL_LIGHT = '#7A4A0C';
  var DEAD_WOOD = '#7C6A55', DEAD_DOT = '#8A7862';

  // ---------- shared bits ----------

  function soil() {
    return '<ellipse cx="50" cy="90.5" rx="16" ry="5" fill="' + SOIL_DARK + '"/>' +
           '<ellipse cx="50" cy="89.3" rx="13.5" ry="3.6" fill="' + SOIL_LIGHT + '"/>';
  }

  // Two-leaf sprout used as stage 0 by most species.
  function sprout(leaf, dark) {
    return '<path d="M50,90 C50,85 50,83 50,79.5" stroke="' + dark + '" stroke-width="1.7" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="45.3" cy="78.2" rx="4.6" ry="2.7" fill="' + leaf + '" transform="rotate(-30 45.3 78.2)"/>' +
      '<ellipse cx="54.7" cy="78.2" rx="4.6" ry="2.7" fill="' + leaf + '" transform="rotate(30 54.7 78.2)"/>';
  }

  function fruitDots(pts, color, r) {
    var s = '';
    for (var i = 0; i < pts.length; i++) {
      s += '<circle cx="' + pts[i][0] + '" cy="' + pts[i][1] + '" r="' + r + '" fill="' + color + '"/>';
    }
    return s;
  }

  // Generic round-canopy tree (oak / cherry / lemon / maple), parameterized by palette.
  // p: { main, dark, light, trunk, dots (per-stage fruit positions), dotColor, dotR }
  function canopyTree(p, stage) {
    if (stage === 0) return sprout(p.main, p.trunk);
    if (stage === 1) {
      return '<rect x="48.9" y="73" width="2.2" height="18" rx="1.1" fill="' + p.trunk + '"/>' +
        '<circle cx="50" cy="69" r="9.5" fill="' + p.main + '"/>' +
        '<circle cx="46.5" cy="65.5" r="4" fill="' + p.light + '"/>';
    }
    if (stage === 2) {
      return '<rect x="48" y="60" width="4" height="31" rx="1.6" fill="' + p.trunk + '"/>' +
        '<circle cx="58" cy="60" r="8.5" fill="' + p.dark + '"/>' +
        '<circle cx="39.5" cy="58" r="9" fill="' + p.main + '"/>' +
        '<circle cx="60.5" cy="57" r="9" fill="' + p.main + '"/>' +
        '<circle cx="50" cy="51" r="13.5" fill="' + p.main + '"/>' +
        '<circle cx="44.5" cy="46" r="5.5" fill="' + p.light + '"/>' +
        (p.dots ? fruitDots(p.dots[0], p.dotColor, p.dotR) : '');
    }
    // stage 3 — full lush tree with flared trunk
    return '<path d="M45,90 L46.8,54 L53.2,54 L55,90 Z" fill="' + p.trunk + '"/>' +
      '<path d="M48,64 L40,56" stroke="' + p.trunk + '" stroke-width="2.4" stroke-linecap="round"/>' +
      '<circle cx="58" cy="55" r="11" fill="' + p.dark + '"/>' +
      '<circle cx="36" cy="51" r="12" fill="' + p.main + '"/>' +
      '<circle cx="64" cy="51" r="12" fill="' + p.main + '"/>' +
      '<circle cx="50" cy="39" r="17" fill="' + p.main + '"/>' +
      '<circle cx="42.5" cy="33.5" r="6.5" fill="' + p.light + '"/>' +
      (p.dots ? fruitDots(p.dots[1], p.dotColor, p.dotR) : '');
  }

  // Bare withered tree used as the 'dead' variant (per-species proportions).
  // o: { h trunk height, w stroke width, droop branches point down }
  function deadBare(o) {
    var topY = 90 - o.h;
    var b1 = 90 - o.h * 0.55, b2 = 90 - o.h * 0.8;
    var dy = o.droop ? 7 : -8;
    var s = '<path d="M50,90 L50,' + topY + '" stroke="' + DEAD_WOOD + '" stroke-width="' + o.w + '" stroke-linecap="round" fill="none"/>' +
      '<path d="M50,' + b1 + ' L38,' + (b1 + dy) + ' M41,' + (b1 + dy * 0.75) + ' L37,' + (b1 + dy * 0.75 + (o.droop ? 5 : -5)) + '" stroke="' + DEAD_WOOD + '" stroke-width="' + (o.w * 0.6) + '" stroke-linecap="round" fill="none"/>' +
      '<path d="M50,' + b2 + ' L61,' + (b2 + dy) + '" stroke="' + DEAD_WOOD + '" stroke-width="' + (o.w * 0.6) + '" stroke-linecap="round" fill="none"/>' +
      '<path d="M50,' + topY + ' L45,' + (topY - 5) + ' M50,' + topY + ' L55,' + (topY - 6) + '" stroke="' + DEAD_WOOD + '" stroke-width="' + (o.w * 0.5) + '" stroke-linecap="round" fill="none"/>';
    // a couple of fallen leaves by the soil
    s += '<circle cx="39" cy="87.5" r="1.4" fill="' + DEAD_DOT + '"/><circle cx="60" cy="88.5" r="1.2" fill="' + DEAD_DOT + '"/>';
    return s;
  }

  // ---------- species ----------

  // Oak — classic round teal-green canopy.
  var OAK = { main: '#3FA98F', dark: '#145A4E', light: '#7FD4B8', trunk: '#7A4A0C' };

  // Cherry Blossom — soft pink canopy with pale blossom dots.
  var CHERRY = {
    main: '#F2A0C0', dark: '#D9799F', light: '#FBD3E2', trunk: '#5C3A0E',
    dots: [[[46, 49], [56, 55], [43, 58]], [[43, 37], [57, 43], [50, 51], [36, 49], [63, 54]]],
    dotColor: '#FDEBF2', dotR: 1.7,
  };

  // Lemon Tree — bright leaf-green canopy with small yellow fruit.
  var LEMON = {
    main: '#8ED320', dark: '#5FA011', light: '#C8F17A', trunk: '#7A4A0C',
    dots: [[[45, 50], [56, 56], [50, 44]], [[44, 38], [57, 44], [50, 52], [37, 50], [63, 53]]],
    dotColor: '#F7D633', dotR: 2,
  };

  // Autumn Maple — warm orange/red canopy.
  var MAPLE = {
    main: '#E8842C', dark: '#C6501F', light: '#F6B45E', trunk: '#5C3A0E',
    dots: [[[45, 50], [56, 55]], [[43, 38], [58, 45], [49, 52]]],
    dotColor: '#D9542B', dotR: 1.8,
  };

  // Pine — layered dark-green triangles on a short trunk.
  function pine(stage) {
    var main = '#1F6B4A', dark = '#145A4E', light = '#2F8F68', trunk = '#5C3A0E';
    if (stage === 0) return sprout(main, trunk);
    if (stage === 1) {
      return '<rect x="49" y="80" width="2" height="11" rx="1" fill="' + trunk + '"/>' +
        '<polygon points="50,60 59,81 41,81" fill="' + main + '"/>' +
        '<polygon points="50,60 55,72 45,72" fill="' + light + '"/>';
    }
    if (stage === 2) {
      return '<rect x="48.4" y="80" width="3.2" height="11" rx="1.4" fill="' + trunk + '"/>' +
        '<polygon points="50,63 64,82 36,82" fill="' + dark + '"/>' +
        '<polygon points="50,46 61,68 39,68" fill="' + main + '"/>' +
        '<polygon points="50,46 55,57 45,57" fill="' + light + '"/>';
    }
    return '<rect x="47.8" y="79" width="4.4" height="12" rx="1.8" fill="' + trunk + '"/>' +
      '<polygon points="50,58 68,81 32,81" fill="' + dark + '"/>' +
      '<polygon points="50,40 65,64 35,64" fill="' + main + '"/>' +
      '<polygon points="50,24 60,46 40,46" fill="' + main + '"/>' +
      '<polygon points="50,24 55,36 45,36" fill="' + light + '"/>';
  }

  // Willow — pale-green dome with a dense curtain of hanging leaf lobes.
  // Each frond is [cx, topY, length, colorKey, rotateDeg]; drawn as a thick vertical ellipse.
  function willowFronds(fronds, cols) {
    var s = '';
    for (var i = 0; i < fronds.length; i++) {
      var f = fronds[i];
      var cy = f[1] + f[2] / 2;
      s += '<ellipse cx="' + f[0] + '" cy="' + cy + '" rx="' + (f[2] * 0.11 + 1.3) + '" ry="' + (f[2] / 2) +
        '" fill="' + cols[f[3]] + '"' +
        (f[4] ? ' transform="rotate(' + f[4] + ' ' + f[0] + ' ' + f[1] + ')"' : '') + '/>';
    }
    return s;
  }
  function willow(stage) {
    var main = '#9CCB7B', dark = '#6FA557', light = '#CBE8B0', trunk = '#7A4A0C';
    var cols = { m: main, d: dark };
    if (stage === 0) return sprout(main, trunk);
    if (stage === 1) {
      return '<rect x="49" y="72" width="2" height="19" rx="1" fill="' + trunk + '"/>' +
        willowFronds([[43, 66, 10, 'd', 4], [50, 68, 11, 'm', 0], [57, 66, 10, 'd', -4]], cols) +
        '<ellipse cx="50" cy="66" rx="9.5" ry="6.5" fill="' + main + '"/>' +
        '<ellipse cx="46.5" cy="63.5" rx="4" ry="2.8" fill="' + light + '"/>';
    }
    if (stage === 2) {
      return '<rect x="48.2" y="60" width="3.6" height="31" rx="1.5" fill="' + trunk + '"/>' +
        willowFronds([
          [39, 53, 15, 'm', 7], [43.5, 56, 18, 'd', 4], [48, 57, 20, 'm', 1],
          [52, 57, 19, 'd', -1], [56.5, 55, 18, 'm', -4], [61, 52, 15, 'd', -7],
        ], cols) +
        '<ellipse cx="50" cy="52" rx="14.5" ry="9.5" fill="' + main + '"/>' +
        '<ellipse cx="50" cy="56" rx="12" ry="4.6" fill="' + dark + '" opacity="0.4"/>' +
        '<ellipse cx="45" cy="48" rx="5.5" ry="3.4" fill="' + light + '"/>';
    }
    return '<path d="M46,90 L47.5,52 L52.5,52 L54,90 Z" fill="' + trunk + '"/>' +
      willowFronds([
        [33, 44, 20, 'm', 9], [38, 49, 24, 'd', 6], [43, 52, 27, 'm', 3],
        [47.5, 53, 29, 'd', 1], [52.5, 53, 28, 'm', -1], [57, 51, 26, 'd', -3],
        [62, 48, 23, 'm', -6], [67, 43, 19, 'd', -9],
      ], cols) +
      '<ellipse cx="50" cy="42" rx="19.5" ry="13" fill="' + main + '"/>' +
      '<ellipse cx="50" cy="48" rx="16" ry="5.5" fill="' + dark + '" opacity="0.4"/>' +
      '<ellipse cx="43" cy="36.5" rx="7" ry="4.6" fill="' + light + '"/>';
  }

  // Cactus — rounded saguaro with arms; dead variant is a slumped grey-brown body.
  function cactus(stage) {
    var main = '#4FA05E', dark = '#35784A', light = '#7CC489';
    if (stage === 0) {
      return '<rect x="47.5" y="80" width="5" height="11" rx="2.5" fill="' + main + '"/>' +
        '<path d="M49,83 v5 M51,83 v5" stroke="' + light + '" stroke-width="0.8" stroke-linecap="round" fill="none"/>';
    }
    if (stage === 1) {
      return '<rect x="46.8" y="70" width="6.4" height="21" rx="3.2" fill="' + main + '"/>' +
        '<path d="M48.5,74 v13 M51.5,74 v13" stroke="' + light + '" stroke-width="0.9" stroke-linecap="round" fill="none"/>';
    }
    if (stage === 2) {
      return '<path d="M47,75 h-5.5 q-3.5,0 -3.5,-3.5 v-7" stroke="' + main + '" stroke-width="5.5" stroke-linecap="round" fill="none"/>' +
        '<rect x="45.5" y="61" width="9" height="30" rx="4.5" fill="' + main + '"/>' +
        '<path d="M48,66 v20 M52,66 v20" stroke="' + light + '" stroke-width="1" stroke-linecap="round" fill="none"/>';
    }
    return '<path d="M47,73 h-8 q-5,0 -5,-5 v-9" stroke="' + main + '" stroke-width="7" stroke-linecap="round" fill="none"/>' +
      '<path d="M53,66 h8 q5,0 5,-5 v-6" stroke="' + dark + '" stroke-width="7" stroke-linecap="round" fill="none"/>' +
      '<rect x="44" y="54" width="12" height="37" rx="6" fill="' + main + '"/>' +
      '<path d="M47,60 v25 M50,58.5 v27 M53,60 v25" stroke="' + light + '" stroke-width="1.1" stroke-linecap="round" fill="none"/>' +
      '<circle cx="50" cy="53" r="2.8" fill="#F2A0C0"/><circle cx="50" cy="53" r="1.1" fill="#F7D633"/>';
  }
  function cactusDead() {
    var body = '#8A7A5E', shade = '#6F6049';
    return '<g transform="rotate(9 50 89)">' +
      '<path d="M46,74 h-7 q-4,0 -4,4 v6" stroke="' + body + '" stroke-width="6" stroke-linecap="round" fill="none"/>' +
      '<path d="M54,70 h7 q4,0 4,5 v4" stroke="' + shade + '" stroke-width="6" stroke-linecap="round" fill="none"/>' +
      '<rect x="45" y="60" width="10" height="31" rx="5" fill="' + body + '"/>' +
      '<path d="M48,65 v18 M52,65 v18" stroke="' + shade + '" stroke-width="1" stroke-linecap="round" fill="none"/>' +
      '</g>' +
      '<circle cx="38" cy="88" r="1.4" fill="' + DEAD_DOT + '"/><circle cx="61" cy="88.5" r="1.2" fill="' + DEAD_DOT + '"/>';
  }

  // Baobab — massive bottle trunk with a small flat canopy.
  function baobab(stage) {
    var trunk = '#9C6B3A', trunkD = '#7A4A0C', main = '#6FBF7A', light = '#A6E0AC', dark = '#3E8E55';
    if (stage === 0) return sprout(main, trunk);
    if (stage === 1) {
      return '<path d="M45.5,90 C46.5,80 47.5,72 48,68 L52,68 C52.5,72 53.5,80 54.5,90 Z" fill="' + trunk + '"/>' +
        '<ellipse cx="50" cy="66" rx="8.5" ry="4.2" fill="' + main + '"/>' +
        '<ellipse cx="46" cy="64.5" rx="4" ry="2.6" fill="' + main + '"/>' +
        '<ellipse cx="54" cy="64.5" rx="4" ry="2.6" fill="' + main + '"/>' +
        '<ellipse cx="47" cy="64" rx="3" ry="1.6" fill="' + light + '"/>';
    }
    if (stage === 2) {
      return '<path d="M41.5,90 C43,74 45,65 46,60 L54,60 C55,65 57,74 58.5,90 Z" fill="' + trunk + '"/>' +
        '<path d="M47,61 L42,55 M53,61 L58,55" stroke="' + trunk + '" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
        '<ellipse cx="50" cy="54" rx="15" ry="5" fill="' + dark + '"/>' +
        '<ellipse cx="50" cy="52.5" rx="13.5" ry="4.6" fill="' + main + '"/>' +
        '<ellipse cx="42.5" cy="50.5" rx="5.5" ry="3.2" fill="' + main + '"/>' +
        '<ellipse cx="57.5" cy="50.5" rx="5.5" ry="3.2" fill="' + main + '"/>' +
        '<ellipse cx="50" cy="49.5" rx="6" ry="3.4" fill="' + main + '"/>' +
        '<ellipse cx="44" cy="50" rx="4" ry="2" fill="' + light + '"/>';
    }
    return '<path d="M37,90 C40,70 43.5,58 44.5,51 L55.5,51 C56.5,58 60,70 63,90 Z" fill="' + trunk + '"/>' +
      '<path d="M42,90 C44,72 46,60 47,52" stroke="' + trunkD + '" stroke-width="1.6" fill="none" opacity="0.55"/>' +
      '<path d="M46,53 L38,44 M54,53 L62,44 M50,52 L50,44" stroke="' + trunk + '" stroke-width="3.2" stroke-linecap="round" fill="none"/>' +
      '<ellipse cx="50" cy="43" rx="22" ry="6.5" fill="' + dark + '"/>' +
      '<ellipse cx="49.5" cy="41" rx="19.5" ry="5.8" fill="' + main + '"/>' +
      '<ellipse cx="38" cy="38.5" rx="7.5" ry="4" fill="' + main + '"/>' +
      '<ellipse cx="62" cy="38.5" rx="7.5" ry="4" fill="' + main + '"/>' +
      '<ellipse cx="50" cy="36.5" rx="9" ry="4.6" fill="' + main + '"/>' +
      '<ellipse cx="42" cy="37" rx="5.5" ry="2.6" fill="' + light + '"/>';
  }
  function baobabDead() {
    return '<path d="M39,90 C42,71 44.5,60 45.5,54 L54.5,54 C55.5,60 58,71 61,90 Z" fill="' + DEAD_WOOD + '"/>' +
      '<path d="M47,56 L40,47 M53,56 L60,48 M50,55 L50,46" stroke="' + DEAD_WOOD + '" stroke-width="3" stroke-linecap="round" fill="none"/>' +
      '<circle cx="38" cy="88" r="1.4" fill="' + DEAD_DOT + '"/><circle cx="61" cy="88.5" r="1.2" fill="' + DEAD_DOT + '"/>';
  }

  // ---------- registry ----------

  var DRAW = {
    oak:    function (s) { return canopyTree(OAK, s); },
    pine:   pine,
    cherry: function (s) { return canopyTree(CHERRY, s); },
    lemon:  function (s) { return canopyTree(LEMON, s); },
    willow: willow,
    cactus: cactus,
    maple:  function (s) { return canopyTree(MAPLE, s); },
    baobab: baobab,
  };

  var DEAD = {
    oak:    function () { return deadBare({ h: 42, w: 5, droop: false }); },
    pine:   function () { return deadBare({ h: 48, w: 4, droop: true }); },
    cherry: function () { return deadBare({ h: 40, w: 4.5, droop: false }); },
    lemon:  function () { return deadBare({ h: 40, w: 4.5, droop: false }); },
    willow: function () { return deadBare({ h: 42, w: 4, droop: true }); },
    cactus: cactusDead,
    maple:  function () { return deadBare({ h: 44, w: 5, droop: false }); },
    baobab: baobabDead,
  };

  function treeInner(speciesId, stage) {
    var id = DRAW.hasOwnProperty(speciesId) ? speciesId : 'oak';
    var st = (stage === 0 || stage === 1 || stage === 2 || stage === 3 || stage === 'dead') ? stage : 3;
    var art = st === 'dead' ? DEAD[id]() : DRAW[id](st);
    return soil() + art;
  }

  function treeSVG(speciesId, stage, opts) {
    var size = (opts && opts.size) || 200;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 100 100">' + treeInner(speciesId, stage) + '</svg>';
  }

  // ---------- isometric diorama tile ----------

  function tileSVG(trees, opts) {
    var size = (opts && opts.size) || 400;
    var list = (trees || []).slice(0, 16);

    // Platform: grass diamond top with brown soil sides.
    var platform =
      '<polygon points="44,142 200,220 200,252 44,174" fill="' + SOIL_LIGHT + '"/>' +
      '<polygon points="200,220 356,142 356,174 200,252" fill="' + SOIL_DARK + '"/>' +
      '<polygon points="200,64 356,142 200,220 44,142" fill="#79C62E"/>' +
      '<polygon points="200,72 340,142 200,212 60,142" fill="#8ED320"/>' +
      '<polygon points="44,142 200,220 200,228 44,150" fill="#5FA011"/>' +
      '<polygon points="200,220 356,142 356,150 200,228" fill="#4C880C"/>';

    // 4x4 iso grid, row-major; sort by screen y so nearer trees draw last.
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      var r = Math.floor(i / 4), c = i % 4;
      var x = 200 + (c - r) * 38;
      var y = 86 + (c + r) * 19;
      var stage = t.result === 'success' ? 3 : 'dead';
      items.push({
        y: y,
        svg: '<g transform="translate(' + (x - 27.5) + ' ' + (y - 49.5) + ') scale(0.55)">' +
          treeInner(t.species, stage) + '</g>',
      });
    }
    items.sort(function (a, b) { return a.y - b.y; });

    var body = platform;
    for (var j = 0; j < items.length; j++) body += items[j].svg;

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + (size * 0.75) +
      '" viewBox="0 0 400 300">' + body + '</svg>';
  }

  window.ForestArt = { SPECIES: SPECIES, treeSVG: treeSVG, tileSVG: tileSVG };
})();
