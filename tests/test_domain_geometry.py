"""The local visual block and backend geographic extent must agree horizontally."""
import pytest
import ocean
from terrain import demo_terrain


def test_requested_horizontal_extent():
    assert ocean.L_KM == pytest.approx(16.5)
    t = demo_terrain(17)
    assert t.L == pytest.approx(16.5)
    b = ocean.bounds()
    assert (b['east'] - b['west']) * ocean.KX == pytest.approx(16.5)
    assert (b['north'] - b['south']) * ocean.KY == pytest.approx(16.5)
