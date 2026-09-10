"""Optional independent check: pip install python-shogi; generate fixtures first."""
import json
from pathlib import Path
import shogi
fixtures = json.loads(Path('tests/differential/differential-fixtures.json').read_text(encoding='utf-8'))
for i, fixture in enumerate(fixtures):
    board = shogi.Board(fixture['sfen'])
    actual = set(fixture['moves'])
    expected = {m.usi() for m in board.legal_moves}
    if actual != expected:
        raise AssertionError(f"Position {i}: {fixture['sfen']}\nExtra: {actual-expected}\nMissing: {expected-actual}")
print(f'PASS: legal moves match python-shogi in {len(fixtures)} seeded midgame positions.')
