// Lichess site adapter.
//
// Isolates EVERYTHING Lichess-specific in one place. content.js (the engine:
// mic, VAD, recording, export) calls only these three functions and knows
// nothing about Lichess. Supporting another chess site later means writing
// a new adapter file with the same interface and selecting it in the manifest.
//
// Position source: the live board is a chessground web component (<cg-board>)
// whose <piece> children carry their type/color as classes and their square
// as a CSS transform. We reconstruct the FEN from that — no network calls,
// no API token, no estimation.

(function () {
  // Game pages look like https://lichess.org/<6-char-id>.
  const NON_GAME_PAGES = new Set([
    'analysis', 'game', 'tv', 'puzzle', 'daily', 'daily-chess', 'study',
    'player', 'practice', 'wiki', 'watch', 'learn', 'api', 'settings',
    'feed', 'account', 'team', 'tournament', 'channel', 'archive', 'swiss',
  ]);

  // Lichess renders the game result in a banner, e.g.:
  //   <section class="status">White resigned • Black is victorious</section>
  // It only appears once the game has a final outcome.
  const GAME_OVER_PATTERNS =
    /is victorious|resigned|is a draw|stalemate|draw|flagged|timeout|out of time|cheated|abandoned|connection lost|threefold|insufficient/i;

  function detectGame() {
    const path = location.pathname;
    const m = path.match(/^\/([a-z0-9]{6})/i);
    const first = path.split('/')[1] || '';
    if (m && !NON_GAME_PAGES.has(first)) {
      return { gameId: first, gameUrl: location.href };
    }
    return { gameId: null, gameUrl: location.href };
  }

  // The move list: Lichess renders one element per move, but obfuscates the
  // tag name and class (e.g. <z7yx class="a1t">d4</z7yx>) and re-randomizes
  // them on every build. So instead of matching a tag or class, we match by
  // shape: leaf elements whose ENTIRE text is a legal SAN move, and whose
  // tag is NOT a standard HTML element (the obfuscated move tags are not).
  const SAN_RE = /^(O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?x?[a-h][1-8](?:=[QRBN])?(?:\+|#)?)$/;
  const STANDARD_TAGS = new Set(('a,abbr,address,article,aside,b,bdi,bdo,body,br,button,canvas,caption,cite,code,col,code,dd,del,details,dfn,div,dl,dt,em,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,head,header,hr,html,i,iframe,img,ins,kbd,label,legend,li,main,map,mark,nav,noscript,ol,optgroup,option,output,p,picture,pre,progress,q,rp,rt,ruby,s,samp,script,section,select,small,source,span,strong,style,sub,summary,sup,table,tbody,td,template,textarea,tfoot,th,thead,time,title,tr,track,u,ul,var,video,wbr').split(','));

  function getMoveList() {
    const leaves = [...document.querySelectorAll('body *')]
      .filter(e => e.children.length === 0
        && !STANDARD_TAGS.has(e.tagName.toLowerCase())
        && SAN_RE.test((e.textContent || '').trim()));
    if (!leaves.length) return null;
    const plies = leaves.length;
    const moves = leaves.map(e => e.textContent.trim());

    // Find the container of the REAL move list (the parent holding the most
    // SAN leaves) and read its move-number labels (plain digits, e.g. "1"
    // .. "8", obfuscated tags). This gives a sanity bound on the count:
    //   - plies < 2*maxNum - 1  -> list is VIRTUALIZED (long game, off-screen
    //                               rows missing) => count is LOW
    //   - plies > 2*maxNum + 1  -> a phantom SAN element from another widget
    //                               matched => count is HIGH
    const byParent = new Map();
    for (const e of leaves) {
      const p = e.parentElement;
      if (p) byParent.set(p, (byParent.get(p) || 0) + 1);
    }
    let listParent = null;
    for (const [p, n] of byParent) {
      if (!listParent || n > byParent.get(listParent)) listParent = p;
    }
    let maxNum = 0;
    if (listParent) {
      for (const c of listParent.children) {
        if (c.children.length === 0 && /^\d+$/.test((c.textContent || '').trim())) {
          maxNum = Math.max(maxNum, parseInt(c.textContent.trim(), 10));
        }
      }
    }
    if (maxNum >= 5) {
      if (plies < 2 * maxNum - 1) {
        console.warn('[CTR] move list may be VIRTUALIZED: ' + plies +
          ' moves seen but labels go to ' + maxNum + ' — move_number may be LOW');
      } else if (plies > 2 * maxNum + 1) {
        console.warn('[CTR] move count ' + plies + ' exceeds 2x' + maxNum +
          ' labels — possible phantom SAN match — move_number may be HIGH');
      }
    }

    return {
      plies: plies,
      moves: moves,
      move_number: Math.floor(plies / 2) + 1, // the move about to be played
      side_to_move: plies % 2 === 0 ? 'w' : 'b',
    };
  }

  // Reconstruct the current position from the board's piece elements.
  //
  //   <cg-board>                          (688px = 8 x 86px squares)
  //     <square class="last-move"> ...    (2 of these: from + to of last move)
  //     <piece class="white knight"
  //            style="transform: translate(172px, 430px);">   -> c3
  //
  // Orientation comes from .cg-wrap (orientation-white | orientation-black).
  //
  // NOTE: castling rights, en-passant and halfmove clock have no DOM source,
  // so they are placeholders in the FEN (" - - 0 1"). move_number is null
  // until we wire in the move list (next step).
  function getBoardState() {
    // Anchor to the MAIN board: a game page can contain several <cg-board>
    // elements (small mirror boards in some layouts/widgets, sometimes
    // frozen on the start position). Strategy: prefer boards inside
    // .round__app__board, and within that scope pick the LARGEST one —
    // the real board is always the biggest one on the page.
    const mainWrap = document.querySelector('.round__app__board');
    const scope = mainWrap || document;
    const boards = [...scope.querySelectorAll('cg-board')]
      .filter(b => b.clientWidth > 0)
      .sort((a, b) => b.clientWidth - a.clientWidth);
    const board = boards[0];
    if (!board) return null;
    if (boards.length > 1) {
      console.log('[CTR] multiple <cg-board> (' + boards.length +
        ', sizes: ' + boards.map(b => b.clientWidth).join('px, ') +
        'px) — using the largest');
    }
    const size = board.clientWidth;
    if (!size) return null;
    const sq = size / 8;
    const wrap = board.closest('.cg-wrap') || document.querySelector('.cg-wrap');
    const flipped = wrap && /orientation-black/.test(wrap.className);

    const letter = { rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k', pawn: 'p' };

    // CSS transform -> board coordinates (file 0..7 = a..h, rank 0..7 = 1..8)
    function coords(el) {
      const t = (el.style.transform || '').match(
        /translate\(([-\d.]+)px(?:,\s*([-\d.]+)px)?\)/);
      if (!t) return null;
      const x = parseFloat(t[1]);
      const y = t[2] !== undefined ? parseFloat(t[2]) : 0;
      let file, rank;
      if (!flipped) {
        file = Math.round(x / sq);
        rank = 7 - Math.round(y / sq);
      } else {
        file = 7 - Math.round(x / sq);
        rank = Math.round(y / sq);
      }
      if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
      return { file, rank };
    }

    const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    const name = s => 'abcdefgh'[s.file] + (s.rank + 1);
    let dropped = 0, overlaps = 0;
    for (const p of board.querySelectorAll('piece')) {
      const c = coords(p);
      if (!c) { dropped++; continue; }
      const type = Object.keys(letter).find(t => p.classList.contains(t));
      if (!type) { dropped++; continue; }
      const ch = p.classList.contains('white')
        ? letter[type].toUpperCase()
        : letter[type];
      if (grid[c.rank][c.file]) overlaps++;
      grid[c.rank][c.file] = ch;
    }
    if (dropped || overlaps) {
      console.warn('[CTR] board decode issues: ' + dropped + ' piece(s) skipped, ' +
        overlaps + ' square overlap(s) — FEN may be incomplete');
    }

    // FEN piece placement, rank 8 down to rank 1
    let fenBoard = '';
    for (let r = 7; r >= 0; r--) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const ch = grid[r][f];
        if (!ch) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += ch;
      }
      if (empty) row += empty;
      fenBoard += (r < 7 ? '/' : '') + row;
    }

    // Last move, from the two highlighted squares: the "to" square still
    // holds a piece (the piece that just moved), the other is "from".
    let lastMove = null;
    let lmFrom = null, lmTo = null;
    const lmSquares = [...board.querySelectorAll('square.last-move')]
      .map(coords).filter(Boolean);
    if (lmSquares.length === 2) {
      lmTo = lmSquares.find(s => grid[s.rank][s.file]) || null;
      lmFrom = lmSquares.find(s => !grid[s.rank][s.file]) || null;
      if (lmTo && lmFrom) {
        lastMove = name(lmFrom) + name(lmTo);
      }
    }

    // Side to move + move number: prefer the move list (exact, from the
    // SAN moves rendered in the list). Fallback: the mover's color from
    // the last-move highlight.
    const pieceCount = grid.flat().filter(c => c).length;

    const ml = getMoveList();
    let stm, move_number;
    if (ml) {
      stm = ml.side_to_move;
      move_number = ml.move_number;
      console.log('[CTR] board: ' + ml.plies + ' plies | ' + ml.moves.join(' '));
    } else if (pieceCount === 32 && !lastMove) {
      // Move list empty + full start position = game not started.
      stm = 'w';
      move_number = 1;
      console.log('[CTR] board: start position -> move 1, w');
    } else {
      stm = lmTo
        ? (grid[lmTo.rank][lmTo.file] === grid[lmTo.rank][lmTo.file].toUpperCase() ? 'b' : 'w')
        : 'w';
      move_number = null;
    }

    return {
      fen: fenBoard + ' ' + stm + ' - - 0 ' + (move_number || 1),
      move_number: move_number,
      side_to_move: stm,
      last_move: lastMove,
    };
  }

  function detectGameOver() {
    const el = document.querySelector('section.status');
    const text = el ? el.textContent.trim() : '';
    return GAME_OVER_PATTERNS.test(text) ? text : null;
  }

  window.CTR_SITE = { detectGame, getBoardState, detectGameOver };
})();
