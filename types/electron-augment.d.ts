// Расширение типов Electron под служебные поля, которые главный процесс вешает на окна.
// Только для проверки типов (tsconfig.check.json) — на рантайм не влияет и в сборку не идёт.
//
// __forceClose  — окно закрывается принудительно (выход из приложения), обработчик 'close'
//                 не должен перехватывать событие и прятать окно в трей.
// __preCompact  — размеры окна до перехода в компактный режим, чтобы вернуть их обратно.
//
// Electron объявляет BrowserWindow классом внутри глобального namespace Electron,
// поэтому дополняем именно его: одноимённый interface сливается с классом.

declare global {
  namespace Electron {
    interface BrowserWindow {
      __forceClose?: boolean;
      __preCompact?: { width: number; height: number } | null;
    }
  }
}

export {};
