"""SQL lint for engine-neutral ordering (SPEC 11.8): every ORDER BY item, in queries and in window
functions, must state NULLS FIRST or NULLS LAST explicitly. DuckDB sorts NULLs last for both ASC and
DESC while BigQuery sorts them first for ASC, so an implicit order can differ between engines.

sqlglot's AST normalizes the NULLS clause away (an implicit default and an explicit one look the same),
so this lint works on tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlglot import Dialect
from sqlglot.tokens import Token, TokenType

TERMINATORS = {
    "LIMIT",
    "OFFSET",
    "ROWS",
    "RANGE",
    "GROUPS",
    "QUALIFY",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "WINDOW",
    "FETCH",
}


@dataclass(frozen=True)
class OrderViolation:
    file: str
    line: int
    item: str


def _tokens(sql: str, dialect: str) -> list[Token]:
    return Dialect.get_or_raise(dialect).tokenize(sql)


def order_by_violations(sql: str, *, file: str = "<sql>", dialect: str = "bigquery") -> list[OrderViolation]:
    tokens = _tokens(sql, dialect)
    depth_before: list[int] = []
    depth = 0
    for tok in tokens:
        depth_before.append(depth)
        if tok.token_type == TokenType.L_PAREN:
            depth += 1
        elif tok.token_type == TokenType.R_PAREN:
            depth -= 1
    out: list[OrderViolation] = []
    for i in range(len(tokens) - 1):
        if tokens[i].token_type != TokenType.ORDER_BY and not (
            tokens[i].text.upper() == "ORDER" and tokens[i + 1].text.upper() == "BY"
        ):
            continue
        start = i + (1 if tokens[i].token_type == TokenType.ORDER_BY else 2)
        d = depth_before[i]
        items: list[list[Token]] = [[]]
        for j in range(start, len(tokens)):
            tok = tokens[j]
            at_level = depth_before[j] == d
            if at_level and tok.token_type == TokenType.R_PAREN:
                break
            if at_level and (tok.token_type == TokenType.SEMICOLON or tok.text.upper() in TERMINATORS):
                break
            if at_level and tok.token_type == TokenType.COMMA:
                items.append([])
                continue
            items[-1].append(tok)
        for item in items:
            if not item:
                continue
            words = [t.text.upper() for t in item]
            explicit = any(
                w == "NULLS" and k + 1 < len(words) and words[k + 1] in ("FIRST", "LAST") for k, w in enumerate(words)
            )
            if not explicit:
                out.append(OrderViolation(file, item[0].line, " ".join(t.text for t in item)))
    return out


def lint_compiled(compiled_dir: Path) -> list[OrderViolation]:
    out: list[OrderViolation] = []
    for path in sorted(compiled_dir.rglob("*.sql")):
        out += order_by_violations(path.read_text(), file=str(path.relative_to(compiled_dir)))
    return out
