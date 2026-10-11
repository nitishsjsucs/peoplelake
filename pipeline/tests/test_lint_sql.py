import pytest

from peoplelake.devtools.lint_sql import order_by_violations


@pytest.mark.parametrize(
    "sql",
    [
        "select * from t order by a nulls last",
        "select * from t order by a asc nulls last, b desc nulls first limit 3",
        "select row_number() over (partition by x order by a desc nulls last) from t",
        "select array_agg(x ignore nulls order by y desc nulls last limit 1)[safe_offset(0)] from t",
        "select lag(a) over w from t window w as (partition by e order by v asc nulls last rows between unbounded preceding and current row)",
        "select a from t",
    ],
)
def test_explicit_nulls_pass(sql):
    assert order_by_violations(sql) == []


@pytest.mark.parametrize(
    ("sql", "item"),
    [
        ("select * from t order by a", "a"),
        ("select * from t order by a nulls last, b desc", "b desc"),
        ("select row_number() over (partition by x order by a desc) from t", "a desc"),
        ("with c as (select * from t order by z) select * from c", "z"),
    ],
)
def test_implicit_nulls_fail(sql, item):
    assert [v.item for v in order_by_violations(sql)] == [item]
