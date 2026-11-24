"""Offline route/concurrency regression tests; remote model replaced, real SQLite."""
import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import database
temporary = tempfile.TemporaryDirectory()
database.DB_PATH = Path(temporary.name) / 'cache.db'
import app as api


class FakeModel:
    def __init__(self):
        self.calls = 0
        self.active = 0
        self.peak = 0
        self.delay = 0
        self.output = '{"risk_level":"high","category":"impersonation"}'
        self.fail = False
        self.lock = threading.Lock()

    def generate_content(self, prompt, **kwargs):
        with self.lock:
            self.calls += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(self.delay)
            if self.fail:
                raise RuntimeError('sensitive provider text must not be logged')
            return SimpleNamespace(text=self.output)
        finally:
            with self.lock:
                self.active -= 1


class BackendTests(unittest.TestCase):
    def setUp(self):
        with contextlib.closing(sqlite3.connect(database.DB_PATH)) as conn, conn:
            conn.execute('DELETE FROM analysis_cache')
            conn.execute('DELETE FROM context_cache')
        api._quota_until = 0
        api.model = FakeModel()
        self.client = api.app.test_client()

    def post(self, text='please transfer money', request_id='test'):
        return self.client.post('/analyze', json={'text': text, 'id': request_id})

    def test_null_text_is_400(self):
        self.assertEqual(self.post(None).status_code, 400)

    def test_missing_text_is_400(self):
        self.assertEqual(self.client.post('/analyze', json={}).status_code, 400)

    def test_non_object_body_is_400(self):
        for data in [[], 17, 'text']:
            with self.subTest(data=data):
                self.assertEqual(self.client.post('/analyze', json=data).status_code, 400)

    def test_invalid_json_is_400(self):
        self.assertEqual(self.client.post('/analyze', data='{', content_type='application/json').status_code, 400)

    def test_wrong_media_type_is_415(self):
        self.assertEqual(self.client.post('/analyze', data='text').status_code, 415)

    def test_empty_text_is_400(self):
        self.assertEqual(self.post('  ').status_code, 400)

    def test_invalid_id_is_400(self):
        for value in [None, 42, 'a' * 129]:
            self.assertEqual(self.post(request_id=value).status_code, 400)

    def test_oversized_body_is_413(self):
        self.assertEqual(self.post('x' * 50000).status_code, 413)

    def test_utf16_limit_matches_frontend(self):
        self.assertEqual(self.post('\U0001f600' * 500).status_code, 413)
        self.assertEqual(self.post('a' * 999).status_code, 200)

    def test_greeting_bypasses_model(self):
        self.assertEqual(self.post(' OK ').json['risk_level'], 'low')
        self.assertEqual(api.model.calls, 0)

    def test_short_risky_text_reaches_model(self):
        self.assertEqual(self.post('匯款').json['risk_level'], 'high')
        self.assertEqual(api.model.calls, 1)

    def test_cache_hit_echoes_current_id(self):
        self.assertEqual(self.post(request_id='first').headers['X-Analysis-Source'], 'gemini')
        hit = self.post(text='please transfer money \u3000\t ', request_id='second')
        self.assertEqual(hit.json['id'], 'second')
        self.assertEqual(hit.headers['X-Analysis-Source'], 'sqlite')
        self.assertEqual(api.model.calls, 1)

    def test_provider_quota_error_returns_429(self):
        class ResourceExhausted(Exception):
            code = 429

        with patch.object(api.model, 'generate_content', side_effect=ResourceExhausted):
            response = self.post()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json['error'], 'provider_rate_limited')
        self.assertIsNone(database.get_cached_result('please transfer money'))
        self.assertGreater(int(response.headers['Retry-After']), 0)

    def context(self, prior='先確認金額', target_speaker='other'):
        return self.client.post('/analyze/context', json={'messages': [
            {'speaker': 'self', 'text': prior}, {'speaker': target_speaker, 'text': '轉好了嗎？'}
        ]})

    def test_context_evidence_verifies_exact_quote_and_keeps_raw_text_out_of_cache(self):
        api.model.output = json.dumps({'risk_level': 'high', 'category': '待查',
            'evidence': [
                {'message': 1, 'quote': '確認金額', 'kind': 'requested_action'},
                {'message': 2, 'quote': '不存在', 'kind': 'risk_signal'},
                {'message': True, 'quote': '確認金額', 'kind': 'risk_signal'}
            ]})
        result = self.context()
        self.assertEqual(result.json['evidence'], [{'message': 1, 'speaker': 'self',
            'quote': '確認金額', 'kind': 'requested_action'}])
        self.assertEqual(self.context().headers['X-Analysis-Source'], 'sqlite')
        with contextlib.closing(sqlite3.connect(database.DB_PATH)) as conn:
            stored = json.loads(conn.execute('SELECT result_json FROM context_cache').fetchone()[0])
        self.assertEqual(stored['evidence'][0], {'message': 1, 'start': 1, 'end': 5, 'kind': 'requested_action'})

    def test_context_cache_is_separate_and_keys_include_turns_and_speakers(self):
        self.post('轉好了嗎？')
        self.assertEqual(self.context().headers['X-Analysis-Source'], 'gemini')
        self.assertEqual(self.context('拒絕核對身分').headers['X-Analysis-Source'], 'gemini')
        self.assertEqual(self.context(target_speaker='self').headers['X-Analysis-Source'], 'gemini')
        self.assertEqual(self.context().headers['X-Analysis-Source'], 'sqlite')
        self.assertEqual(api.model.calls, 4)

    def test_invalid_context_is_rejected_before_provider(self):
        response = self.client.post('/analyze/context', json={'messages': [{'speaker': 'self', 'text': 'OK'}]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(api.model.calls, 0)

    def test_quota_pause_applies_across_routes_but_preserves_cache_and_rules(self):
        class ResourceExhausted(Exception):
            code = 429
        self.assertEqual(self.post().status_code, 200)
        with patch.object(api.model, 'generate_content', side_effect=ResourceExhausted) as model:
            self.assertEqual(self.context().status_code, 429)
            self.assertEqual(self.post('uncached text').status_code, 429)
            self.assertEqual(self.post().headers['X-Analysis-Source'], 'sqlite')
            self.assertEqual(self.post('OK').headers['X-Analysis-Source'], 'rule')
            self.assertEqual(model.call_count, 1)

    def test_normalizes_risk_and_category(self):
        api.model.output = '{"risk_level":" HIGH ","category":" test "}'
        self.assertEqual(self.post().json, {'id':'test','risk_level':'high','category':'test'})

    def test_json_fence_is_accepted(self):
        api.model.output = '```json\n{"risk_level":"medium","category":"test"}\n```'
        self.assertEqual(self.post().json['risk_level'], 'medium')

    def test_invalid_enum_is_502_not_cached(self):
        api.model.output = '{"risk_level":"surprise","category":"test"}'
        self.assertEqual(self.post().status_code, 502)
        self.assertIsNone(database.get_cached_result('please transfer money'))

    def test_invalid_output_shapes_are_rejected(self):
        for value in [[], None, {}, {'risk_level':'low','category':42},
                      {'risk_level':'low','category':''}, {'risk_level':'low','category':'a'*121}]:
            with self.subTest(value=value):
                api.model.output = json.dumps(value)
                self.assertEqual(self.post().status_code, 502)

    def test_malformed_model_json_is_502(self):
        api.model.output = 'not JSON'
        self.assertEqual(self.post().status_code, 502)

    def test_provider_failure_does_not_poison_retry(self):
        api.model.fail = True
        self.assertEqual(self.post().status_code, 503)
        api.model.fail = False
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(api.model.calls, 2)
        self.assertFalse(api._flights)

    def test_cache_write_failure_preserves_valid_prediction(self):
        with patch.object(database, 'save_result', side_effect=sqlite3.OperationalError('locked')):
            self.assertEqual(self.post().status_code, 200)

    def test_invalid_cache_is_reanalyzed(self):
        with patch.object(database, 'get_cached_result', return_value={'risk_level':'unknown','category':'x'}):
            self.assertEqual(self.post().json['risk_level'], 'high')
            self.assertEqual(api.model.calls, 1)

    def test_parallel_identical_requests_share_one_model_call(self):
        api.model.delay = 0.15
        barrier = threading.Barrier(8)
        def submit(i):
            barrier.wait()
            with api.app.test_client() as client:
                return client.post('/analyze', json={'text':'parallel same message','id':str(i)})
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(submit, range(8)))
        self.assertTrue(all(r.status_code == 200 for r in responses))
        self.assertEqual([r.json['id'] for r in responses], list(map(str,range(8))))
        self.assertEqual(api.model.calls, 1)
        self.assertFalse(api._flights)

    def test_parallel_unique_requests_limit_model_concurrency(self):
        api.model.delay = 0.1
        def submit(i):
            with api.app.test_client() as client:
                return client.post('/analyze', json={'text':f'unique message {i}'})
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(submit, range(8)))
        self.assertTrue(all(r.status_code == 200 for r in responses))
        self.assertEqual(api.model.calls, 8)
        self.assertLessEqual(api.model.peak, 4)

    def test_missing_key_returns_controlled_error(self):
        api.model = None
        with patch.dict(os.environ, {'GEMINI_API_KEY':''}):
            response = self.post()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json['error'], 'missing_api_key')

    def test_cors_rejects_unknown_origin(self):
        response = self.client.post('/analyze', json={'text':'OK'}, headers={'Origin':'https://example.org'})
        self.assertNotIn('Access-Control-Allow-Origin', response.headers)
        response = self.client.post('/analyze', json={'text':'OK'}, headers={'Origin':'https://www.messenger.com'})
        self.assertEqual(response.headers['Access-Control-Allow-Origin'],'https://www.messenger.com')

    def test_no_raw_text_in_application_logs(self):
        api.model.fail = True
        with self.assertLogs(api.app.logger, level='WARNING') as logs:
            self.post('private message example')
        self.assertIn('Analysis provider failed (RuntimeError)', ' '.join(logs.output))
        self.assertNotIn('private message example', ' '.join(logs.output))
        self.assertNotIn('sensitive provider text', ' '.join(logs.output))

    def test_cache_namespace_changes_with_model_prompt(self):
        self.assertNotEqual(database.CACHE_VERSION, 'flash-lite-v1')
        original = database.CACHE_VERSION
        first = database.get_hash('same')
        try:
            database.CACHE_VERSION = 'other-version'
            self.assertNotEqual(first, database.get_hash('same'))
        finally:
            database.CACHE_VERSION = original


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BackendTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    out = Path(os.environ.get('TEST_RESULTS_DIR', str(Path(__file__).resolve().parents[1]/'test-results')))
    out.mkdir(parents=True, exist_ok=True)
    (out/'backend.json').write_text(json.dumps({'tests':result.testsRun,
        'failures':len(result.failures), 'errors':len(result.errors),
        'model':'deterministic local fake; no remote API calls'},indent=2),encoding='utf-8')
    sys.exit(not result.wasSuccessful())
