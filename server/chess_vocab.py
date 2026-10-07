# Chess vocabulary used to bias Whisper's decoding via `initial_prompt`.
# Ported from ChessRecorder/src/chess-vocab.js (which used these same lists
# for a fuzzy post-correction step in the browser-only version). Here they
# do real work at the model level: Whisper conditions its next-token
# predictions on this prompt text, so it's measurably more likely to
# produce "Caro-Kann" instead of "caro cálida" when it actually hears that
# opening name, PROVIDED it's plausible given the audio (this is biasing,
# not dictation — it won't invent words that weren't said).
#
# Kept general-purpose (pieces, tactics/strategy jargon, common openings)
# rather than tied to one game, so it helps any player's commentary.

VOCAB = {
    "en": [
        "pawn", "knight", "bishop", "rook", "queen", "king",
        "check", "checkmate", "stalemate", "castle", "castling", "kingside",
        "queenside", "en passant", "promotion", "capture", "blunder",
        "brilliant", "fork", "pin", "skewer", "discovered attack",
        "double attack", "zwischenzug", "zugzwang", "fianchetto", "gambit",
        "sacrifice", "exchange", "opening", "middlegame", "endgame",
        "tempo", "initiative", "outpost", "prophylaxis", "pawn structure",
        "isolated pawn", "passed pawn", "doubled pawns", "back rank",
        "weak square", "open file", "bishop pair", "material",
        "development", "resign", "draw", "threefold repetition",
        "perpetual check", "time trouble", "Sicilian", "Caro-Kann",
        "French Defense", "Italian Game", "Ruy Lopez", "Queen's Gambit",
        "King's Indian", "English Opening", "Scandinavian",
        "London System", "Grünfeld", "Nimzo-Indian",
    ],
    "es": [
        "peón", "caballo", "alfil", "torre", "dama", "reina", "rey",
        "jaque", "jaque mate", "ahogado", "enrroque", "enrrocar",
        "flanco de rey", "flanco de dama", "al paso", "coronación",
        "captura", "error grave", "jugada brillante", "horquilla",
        "clavada",  "ataque descubierto", "doble ataque",
        "zugzwang", "fianchetto", "gambito", "sacrificio", "cambio",
        "apertura", "medio juego", "final", "finales", "tiempo",
        "iniciativa", "profilaxis",
        "estructura de peones", "peón aislado", "peón pasado",
        "peones doblados", "octava fila", "columna abierta",
        "pareja de alfiles", "material", "desarrollo", "abandono",
        "tablas", "repetición", "jaque perpetuo", "apuro de tiempo",
        "Siciliana", "Caro-Kann", "Francesa", "Italiana",
        "Ruy López", "Gambito de Dama", "India de Rey",
        "Apertura Inglesa", "Escandinava", "Londres", "Grünfeld",
        "Nimzoindia", "Avanzar",
    ],
    "de": [
        "bauer", "springer", "läufer", "turm", "dame", "könig",
        "schach", "schachmatt", "patt", "rochade", "rochieren",
        "kurze rochade", "lange rochade", "en passant", "umwandlung",
        "schlagen", "fehler", "brillante zug", "gabel", "fesselung",
        "spieß", "abzugsschach", "doppelangriff", "zugzwang",
        "fianchetto", "gambit", "opfer", "abtausch", "eröffnung",
        "mittelspiel", "endspiel", "tempo", "initiative", "außenposten",
        "prophylaxe", "bauernstruktur", "isolierter bauer", "freibauer",
        "doppelbauern", "grundreihe", "offene linie", "läuferpaar",
        "material", "entwicklung", "aufgeben", "remis",
        "stellungswiederholung", "dauerschach", "zeitnot",
        "Sizilianisch", "Caro-Kann", "Französisch", "Italienisch",
        "Spanisch", "Damengambit", "Königsindisch", "Englisch",
        "Skandinavisch", "Londoner System", "Grünfeld", "Nimzoindisch",
    ],
}

_LEAD_IN = {
    "en": "Chess commentary. Relevant terms: ",
    "es": "Comentario de ajedrez. Términos relevantes: ",
    "de": "Schachkommentar. Relevante Begriffe: ",
}

MOVES_LEAD = {
    "en": "Possible moves: ",
    "es": "Posibles jugadas: ",
    "de": "Mögliche Züge: ",
}

# Piece names used to render legal moves as *spoken* phrases (the prompt
# biases the model toward what the player would actually say — "caballo a
# f6", never "Nf6").
_PIECE = {
    "en": {"pawn": "pawn", "knight": "knight", "bishop": "bishop", "rook": "rook",
           "queen": "queen", "king": "king", "to": "to", "castling_k": "short castling",
           "castling_q": "long castling", "promo": "promoting to"},
    "es": {"pawn": "peón", "knight": "caballo", "bishop": "alfil", "rook": "torre",
           "queen": "dama", "king": "rey", "to": "a", "castling_k": "enroque corto",
           "castling_q": "enroque largo", "promo": "coronación a"},
    "de": {"pawn": "Bauer", "knight": "Springer", "bishop": "Läufer", "rook": "Turm",
           "queen": "Dame", "king": "König", "to": "nach", "castling_k": "kurze Rochade",
           "castling_q": "lange Rochade", "promo": "Umwandlung in"},
}
_PIECE_TYPE = {}  # filled at import (chess enum -> key), guarded: python-chess
                  # is optional at import time, only needed for this feature.


def vocab_terms(language):
    """The plain term list for a language (en/es/de), or None."""
    return VOCAB.get(language)


def get_prompt(language):
    """Return an initial_prompt string for the given language code
    ('en'|'es'|'de'), or None for 'auto'/unknown (no prompt: let Whisper
    auto-detect language without a biasing hint)."""
    terms = VOCAB.get(language)
    if not terms:
        return None
    return _LEAD_IN[language] + ", ".join(terms) + "."


# Whisper's hard cap for the combined prompt (tokens).
PROMPT_MAX_TOKENS = 418


def build_prompt(language, moves_phrases, tok_len):
    """Assemble the final initial_prompt for a segment.

    Args:
      language: 'en'|'es'|'de' ('auto'/unknown -> None, no biasing).
      moves_phrases: optional list of spoken legal-move phrases from
        describe_legal_moves(). The move list is position-specific and is
        therefore ALWAYS kept in full; if the combined prompt exceeds
        PROMPT_MAX_TOKENS, vocabulary terms are dropped from the tail
        (openings/niche terms go first, core piece/tactic terms survive).
      tok_len: callable(str) -> token count, supplied by the server so
        this module stays free of faster-whisper imports.
    """
    lead = _LEAD_IN.get(language)
    if lead is None:
        return None
    terms = VOCAB.get(language) or []
    moves_part = (" " + MOVES_LEAD[language] + " ".join(moves_phrases) + ".") \
        if moves_phrases else ""
    n = len(terms)
    while True:
        vocab_part = (lead + ", ".join(terms[:n]) + ".") if n else lead.rstrip()
        prompt = vocab_part + moves_part
        if n == 0 or tok_len(prompt) <= PROMPT_MAX_TOKENS:
            return prompt
        n -= 1


def describe_legal_moves(fen, language):
    """Render every legal move of a position as a spoken phrase in the
    given language, e.g. for white to move after 1.d4:
    ['peón a a3', 'peón a a4', ..., 'caballo a c3', 'caballo a f3'].

    Returns a list of phrases, or None if the FEN is invalid, the
    language is unknown, or python-chess is unavailable. Pure description
    — no SAN anywhere, because the prompt must sound like speech.
    """
    P = _PIECE.get(language)
    if not P:
        return None
    try:
        import chess as _chess
    except ImportError:
        return None
    try:
        board = _chess.Board(fen)
    except ValueError:
        return None
    if not _PIECE_TYPE:
        _PIECE_TYPE.update({
            _chess.PAWN: "pawn", _chess.KNIGHT: "knight", _chess.BISHOP: "bishop",
            _chess.ROOK: "rook", _chess.QUEEN: "queen", _chess.KING: "king",
        })
    out = []
    for move in board.legal_moves:
        san = board.san(move)
        to_sq = _chess.square_name(move.to_square)
        if san == "O-O":
            out.append(P["castling_k"])
        elif san == "O-O-O":
            out.append(P["castling_q"])
        elif move.promotion:
            promo_piece = P[_PIECE_TYPE[move.promotion]]
            out.append(f"{P['pawn']} {P['to']} {to_sq}, {P['promo']} {promo_piece}")
        else:
            piece = board.piece_at(move.from_square)
            name = P[_PIECE_TYPE[piece.piece_type]]
            out.append(f"{name} {P['to']} {to_sq}")
    return out
