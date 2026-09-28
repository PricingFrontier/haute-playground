"""Starter tests for haute-playground.

Extend these tests with execution assertions as your pipeline grows.
"""

from __future__ import annotations

from pathlib import Path

from haute.parser import parse_pipeline_file

PIPELINE_FILE = Path(__file__).resolve().parent.parent / "rating" / "main.py"


def test_pipeline_parses() -> None:
    """The pipeline remains valid Haute source."""
    graph = parse_pipeline_file(PIPELINE_FILE)
    assert graph.pipeline_name == "haute-playground"
