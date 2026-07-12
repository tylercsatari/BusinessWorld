import unittest

import numpy as np

from hook_quality import retention_inputs


class HookQualityTests(unittest.TestCase):
    def test_retention_inputs_keep_variable_hook_lengths_as_a_confound(self):
        corpus = [{
            "curve": [1.1, 1.0, .9, .8, .7],
            "duration_s": 10,
            "hookEndSec": 4,
            "keep_rate": 65,
        }]
        observed = retention_inputs(corpus, np.asarray([11]))
        self.assertEqual(observed["retentionMatrix"].shape, (1, 6))
        self.assertEqual(observed["confounds"].shape, (1, 7))
        self.assertEqual(observed["confounds"][0, 0], 11)


if __name__ == "__main__":
    unittest.main()
