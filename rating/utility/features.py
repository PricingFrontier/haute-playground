"""Feature engineering utilities for pipeline nodes.

Add project-specific utility functions, constants, and column mappings here.
These are imported into main.py so your pipeline nodes stay clean and readable.
"""

from __future__ import annotations

from collections.abc import Callable

import polars as pl

# ── Date helpers ──────────────────────────────────────────────────────


def to_date(col_name: str, fmt: str = "%Y-%m-%d") -> pl.Expr:
    """Parse a string column to a date.

    Example::

        to_date("proposer.date_of_birth")
    """
    return pl.col(col_name).str.to_date(fmt)


def years_between(earlier: pl.Expr, later: pl.Expr) -> pl.Expr:
    """Whole years between two date expressions (floor).

    Example::

        years_between(to_date("date_of_birth"), to_date("cover_start_date")).alias("age")
    """
    return ((later - earlier).dt.total_days() / 365.25).floor().cast(pl.Int64)


def months_between(earlier: pl.Expr, later: pl.Expr) -> pl.Expr:
    """Calendar months between two date expressions.

    Uses year/month subtraction so Jan 1 to Jul 1 = 6, not 5.

    Example::

        months_between(to_date("start_date"), to_date("end_date")).alias("tenure_months")
    """
    return (later.dt.year() - earlier.dt.year()) * 12 + (
        later.dt.month() - earlier.dt.month()
    )


def days_between(earlier: pl.Expr, later: pl.Expr) -> pl.Expr:
    """Days between two date expressions.

    Example::

        days_between(to_date("order_date"), to_date("ship_date")).alias("fulfillment_days")
    """
    return (later - earlier).dt.total_days()


# ── String helpers ────────────────────────────────────────────────────


def postcode_area(col_name: str) -> pl.Expr:
    """Extract the outward code (first part) from a UK postcode.

    ``"SW1A 2AA"`` → ``"SW1A"``, ``"B1 1BB"`` → ``"B1"``

    Example::

        postcode_area("postcode").alias("postcode_area")
    """
    return pl.col(col_name).str.split(" ").list.first()


# ── Column cleaning ──────────────────────────────────────────────────


def clean_columns(df: pl.LazyFrame) -> pl.LazyFrame:
    """Replace every ``.`` with ``_`` in column names.

    Example::

        df = clean_columns(quotes)
    """
    rename = {c: c.replace(".", "_") for c in df.collect_schema().names() if "." in c}
    return df.rename(rename) if rename else df


# ── Column matching ──────────────────────────────────────────────────


def cols_matching(all_cols: list[str], pattern_fn: Callable[[str], bool]) -> list[str]:
    """Return columns from *all_cols* where pattern_fn(col) is True.

    Example::

        age_cols = cols_matching(df.collect_schema().names(),
                                 lambda c: c.endswith("_age"))
    """
    return [c for c in all_cols if pattern_fn(c)]
