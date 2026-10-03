"""Check turn cleanup without loading Hermes or any credentials."""
import runpy
import signal
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

warm = runpy.run_path(sys.argv.pop(1))


class TurnCleanup(unittest.TestCase):
    def test_signals_only_members_of_the_completed_turn(self):
        entries = [SimpleNamespace(name=name) for name in ['self', '101', '102', '103']]
        with patch('os.scandir', return_value=entries), \
                patch('os.getpgid', side_effect=lambda pid: 100 if pid in (101, 102) else 200), \
                patch('os.kill') as kill, \
                patch('os.killpg', side_effect=PermissionError('OpenShell denies group signals')) as killpg:
            warm['kill_turn_children'](100)
        self.assertEqual(kill.call_args_list, [unittest.mock.call(101, signal.SIGKILL),
                                              unittest.mock.call(102, signal.SIGKILL)])
        killpg.assert_not_called()

    def test_tolerates_a_child_exiting_during_cleanup(self):
        with patch('os.scandir', return_value=[SimpleNamespace(name='101')]), \
                patch('os.getpgid', side_effect=ProcessLookupError), patch('os.kill') as kill:
            warm['kill_turn_children'](100)
        kill.assert_not_called()

    def test_does_not_hide_a_denied_child_cleanup(self):
        with patch('os.scandir', return_value=[SimpleNamespace(name='101')]), \
                patch('os.getpgid', return_value=100), \
                patch('os.kill', side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                warm['kill_turn_children'](100)


unittest.main()
