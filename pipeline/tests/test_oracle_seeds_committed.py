from peoplelake.generator.seeds import seed_files
from peoplelake.paths import warehouse_dir


def test_committed_seeds_equal_regenerated():
    seeds = warehouse_dir() / "seeds"
    for rel, text in seed_files().items():
        path = seeds / rel
        assert path.is_file(), f"missing committed seed {rel}; run `peoplelake generate --write-seeds`"
        assert path.read_text(encoding="utf-8") == text, f"{rel} is stale; run `peoplelake generate --write-seeds`"


def test_oracle_seed_has_936_rows():
    text = (warehouse_dir() / "seeds" / "oracle" / "oracle_workforce_monthly.csv").read_text()
    lines = text.strip().split("\n")
    assert len(lines) == 1 + 936
    assert sum(1 for line in lines if line.startswith("full,")) == 468
