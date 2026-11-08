import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 한국어 글꼴을 앱에 담아 운영체제와 관계없이 같은 글자 모양으로 보이게 합니다.
import 'pretendard/dist/web/variable/pretendardvariable.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
