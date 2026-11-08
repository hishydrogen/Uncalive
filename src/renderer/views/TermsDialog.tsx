import { useState } from 'react';
import { call } from '../api';
import { Dialog } from '../components';

/**
 * 처음 실행할 때 보여 주는 안내입니다. 동의해야 앱을 쓸 수 있고, 동의한 뒤에는 다시 보이지 않습니다.
 * 내용을 바꾸면 메인 프로세스의 termsVersion을 올려 한 번 더 동의를 받습니다.
 */
export function TermsDialog() {
  const [agreed, setAgreed] = useState(false);
  return (
    <Dialog title="언카라이브를 쓰기 전에" onClose={() => undefined} dismissable={false} width={580}>
      <div className="terms">
        <p>언카라이브는 아카라이브에서 스크랩하거나 직접 고른 글을 내 컴퓨터에 보관하는 <strong>비공식 프로그램</strong>입니다. 아카라이브 운영사와 관계가 없으며, 운영사가 만들거나 허락한 프로그램이 아닙니다.</p>
        <h3>사이트에 부담을 주지 말아 주세요</h3>
        <ul>
          <li>언카라이브는 글 사이에 기다리고, 원본 서버에는 동시에 두 개까지만 연결하도록 만들어져 있습니다. 설정의 대기 시간을 지나치게 줄이지 마세요.</li>
          <li>짧은 시간에 아주 많은 글을 받거나, 같은 목록을 쉴 새 없이 되풀이해 받지 마세요. 이용이 제한되거나 계정이 제재될 수 있습니다.</li>
          <li>아카라이브 이용약관과 각 채널의 규칙을 지켜 주세요.</li>
        </ul>
        <h3>받은 글은 개인 보관용으로만 써 주세요</h3>
        <ul>
          <li>글과 사진, 동영상의 권리는 각 작성자에게 있습니다. 받은 파일을 다시 올리거나 퍼뜨리지 마세요.</li>
          <li>다른 사람의 개인정보가 담긴 글은 특히 조심해서 다뤄 주세요.</li>
        </ul>
        <h3>책임</h3>
        <ul>
          <li>이 프로그램을 쓰면서 생기는 모든 결과의 책임은 사용자에게 있습니다. 프로그램은 있는 그대로 제공되며, 사이트가 바뀌면 동작하지 않을 수 있습니다.</li>
          <li>로그인은 아카라이브 화면에서 직접 하며, 언카라이브는 비밀번호를 읽거나 저장하지 않습니다.</li>
        </ul>
      </div>
      <label className="terms-agree">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} autoFocus />
        <span>위 내용을 읽었으며, 지켜서 쓰겠습니다.</span>
      </label>
      <div className="dialog-buttons">
        <button onClick={() => void call('quit')}>종료</button>
        <button className="primary" disabled={!agreed} onClick={() => void call('acceptTerms')}>확인</button>
      </div>
    </Dialog>
  );
}
