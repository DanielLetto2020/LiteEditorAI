#!/usr/bin/env python3
# LiteEditorAI — сайдкар синтеза речи (модуль «Озвучка»).
#
# Зачем отдельный процесс: русского Silero не существует в ONNX (проверено, см. docs/TTS_VOICE.md),
# только PyTorch `.pt` — внутрь Electron такой движок не встроить. Поэтому main.js поднимает этот
# скрипт в интерпретаторе, у которого есть torch, и общается с ним построчно.
#
# Протокол: одна JSON-строка на запрос в stdin → одна JSON-строка на ответ в stdout.
# Бинарь по трубе не гоняем: синтезированное пишется в WAV-файл по указанному пути (`out`),
# в ответе — только путь и длительность. Кэшем и именами файлов распоряжается вызывающая сторона.
#
#   {"id":1,"op":"ping"}                                  → {"id":1,"ok":true,"loaded":false}
#                                                         (+ sampleRate и omographs — что умеет модель)
#   {"id":3,"op":"speak","text":"…","voice":"xenia",
#    "rate":"medium","out":"/tmp/x.wav"}                  → {"id":3,"ok":true,"file":"…","dur":3.6}
#   {"id":4,"op":"quit"}                                  → процесс завершается
#
# Ошибка любого запроса — {"id":N,"ok":false,"error":"…"}: контракт ошибок редактора (см. CLAUDE.md).
# Диагностика идёт в stderr, его пишет в лог main.

import argparse
import inspect
import json
import os
import sys
import time
import wave

# Частота выбирается по модели: v5 синтезирует 48 кГц честно, v4 умеет только 24 кГц и всё, что
# выше, просто интерполирует — файл вдвое тяжелее, звук тот же. Значение уезжает в hello/ping.
SR_MODERN = 48000
SR_LEGACY = 24000
SAMPLE_RATE = SR_LEGACY
# Silero принимает только эти ступени темпа (числовые проценты мапятся на них же).
RATES = ('x-slow', 'slow', 'medium', 'fast', 'x-fast')
# Известный список дикторов русской модели — ответ на `voices` до загрузки (сотню мегабайт
# грузить ради списка незачем). После загрузки список берётся у самой модели; в v4 и v5 он один
# и тот же.
DEFAULT_VOICES = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene']

model = None
model_path = None
# Какие именованные аргументы принимает apply_tts ИМЕННО этой модели. v5 добавила ударения в
# омографах и силу интонации, а v4 на них падает TypeError — поэтому подмешиваем по факту, а не
# по имени файла: имя пользователь волен поменять, а сигнатура не врёт.
caps = set()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def load_model():
    global model, caps, SAMPLE_RATE
    if model is not None:
        return model
    import torch  # импорт тут, а не сверху: `ping`/`voices` должны отвечать и без torch
    t0 = time.time()
    model = torch.package.PackageImporter(model_path).load_pickle('tts_models', 'model')
    model.to('cpu')
    try:
        caps = set(inspect.signature(model.apply_tts).parameters)
    except (TypeError, ValueError):
        caps = set()
    SAMPLE_RATE = SR_MODERN if 'put_stress_homo' in caps else SR_LEGACY
    log('model loaded in %.2f s: %s (sr=%d, omographs=%s)'
        % (time.time() - t0, model_path, SAMPLE_RATE, 'put_stress_homo' in caps))
    return model


def voices():
    if model is not None:
        got = [v for v in getattr(model, 'speakers', []) if v != 'random']
        if got:
            return got
    return list(DEFAULT_VOICES)


def esc(text):
    """Экранирование для SSML: иначе `&` или `<` из вывода терминала роняют парсер Silero."""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def write_wav(path, samples):
    # Пишем в сосед .part и переименовываем: rename(2) атомарен в пределах ФС, поэтому файл в
    # кэше либо целый, либо его нет. Прямая запись оставляла обрезанный WAV, который потом
    # отдавался как готовая фраза (кэш проверяет только наличие файла).
    tmp = str(path) + '.part'
    try:
        with wave.open(tmp, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(samples.tobytes())
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def synth(text, voice, rate, out):
    m = load_model()
    kw = dict(speaker=voice, sample_rate=SAMPLE_RATE, put_accent=True, put_yo=True)
    # v5: ударения в омографах ставятся сами («з+амок» ≠ «зам+ок»), человеку не надо жать Ctrl+U
    # на каждом. У v4 этих аргументов нет вовсе — передать их значит уронить синтез.
    if 'put_stress_homo' in caps:
        kw['put_stress_homo'] = True
    if 'put_yo_homo' in caps:
        kw['put_yo_homo'] = True
    # Темп меняем через SSML — он растягивает речь, не трогая высоту голоса (playbackRate в плеере
    # так не умеет: там вместе со скоростью уезжает тембр).
    if rate and rate != 'medium':
        audio = m.apply_tts(ssml_text='<speak><prosody rate="%s">%s</prosody></speak>' % (rate, esc(text)), **kw)
    else:
        audio = m.apply_tts(text=text, **kw)
    data = (audio.numpy() * 32767).astype('<i2')
    write_wav(out, data)
    return len(data) / float(SAMPLE_RATE)


def handle(req):
    op = req.get('op')
    if op == 'ping':
        return {'ok': True, 'loaded': model is not None, 'voices': voices(),
                'sampleRate': SAMPLE_RATE, 'omographs': 'put_stress_homo' in caps}
    if op == 'speak':
        text = (req.get('text') or '').strip()
        if not text:
            return {'ok': False, 'error': 'пустой текст'}
        voice = req.get('voice') or 'xenia'
        if voice not in voices():
            return {'ok': False, 'error': 'нет такого голоса: ' + voice}
        rate = req.get('rate') or 'medium'
        if rate not in RATES:
            rate = 'medium'
        out = req.get('out')
        if not out:
            return {'ok': False, 'error': 'не указан файл вывода'}
        t0 = time.time()
        dur = synth(text, voice, rate, out)
        return {'ok': True, 'file': out, 'dur': round(dur, 3), 'took': round(time.time() - t0, 3)}
    return {'ok': False, 'error': 'неизвестная операция: ' + str(op)}


def main():
    global model_path
    # Труба с main — всегда UTF-8 (JSON.stringify пишет кириллицу как есть, main читает ответы как
    # UTF-8). Python же у труб берёт кодировку локали: на Windows это ANSI (cp1251/cp1252) — текст
    # фразы приходил кракозябрами или ронял чтение stdin UnicodeDecodeError, а печать кириллической
    # ошибки в cp1252 роняла сайдкар UnicodeEncodeError. Менять кодировку можно только до чтения.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='путь к модели ru (torch.package): v5_5_ru.pt, v4_ru.pt…')
    ap.add_argument('--preload', action='store_true', help='загрузить модель сразу, не ждать первого speak')
    args = ap.parse_args()
    model_path = args.model
    if args.preload:
        try:
            load_model()
        except Exception as e:  # noqa: BLE001 — упасть тут нельзя, ответ об ошибке нужен вызывающему
            log('preload failed: %s: %s' % (type(e).__name__, e))
    print(json.dumps({'op': 'hello', 'ok': True, 'voices': voices(),
                      'sampleRate': SAMPLE_RATE, 'omographs': 'put_stress_homo' in caps}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'ok': False, 'error': 'битый JSON: %s' % e}), flush=True)
            continue
        if req.get('op') == 'quit':
            break
        try:
            res = handle(req)
        except ValueError as e:
            # Silero кидает пустой ValueError на тексте, где нечего произносить (нет кириллицы).
            # Вызывающая сторона такие фразы отсеивает заранее, но подстраховываемся и здесь —
            # с внятным текстом, иначе в логе редактора видно только «ValueError: ».
            log('ValueError: %r' % (str(e),))
            res = {'ok': False, 'error': str(e) or 'движок не смог произнести эту фразу'}
        except Exception as e:  # noqa: BLE001 — любая ошибка синтеза уходит наверх текстом
            log('%s: %s' % (type(e).__name__, e))
            res = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        res['id'] = req.get('id')
        print(json.dumps(res, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
