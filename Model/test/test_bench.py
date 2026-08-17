from goldset.bench import quadratic_weighted_kappa


def test_perfect_agreement_is_one():
    assert quadratic_weighted_kappa([-2, -1, 0, 1, 2], [-2, -1, 0, 1, 2]) == 1.0


def test_perfect_disagreement_on_two_symmetric_labels_is_minus_one():
    # Hand-computable case: observed weight 2/16, expected 1/16 → kappa = -1.
    assert quadratic_weighted_kappa([0, 1], [1, 0]) == -1.0


def test_constant_labels_degenerate_to_one():
    # Zero expected disagreement: define as 1.0 rather than dividing by zero.
    assert quadratic_weighted_kappa([1, 1], [1, 1]) == 1.0


def test_near_misses_beat_far_misses():
    near = quadratic_weighted_kappa([-2, 0, 2], [-1, 1, 2])
    far = quadratic_weighted_kappa([-2, 0, 2], [2, -2, -2])
    assert near > far
