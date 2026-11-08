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
    <Dialog title="언카라이브를 시작하기 전에" onClose={() => undefined} dismissable={false} width={580}>
      <div className="terms">
        <p>언카라이브는 아카라이브에서 스크랩하거나 선택한 글을 컴퓨터에 저장해 두고 읽는 <strong>비공식 프로그램</strong>입니다. 아카라이브 운영사와는 무관하며, 공식적으로 승인된 프로그램이 아닙니다.</p>
        <h3>서버에 무리를 주지 마세요</h3>
        <ul>
          <li>언카라이브는 서버 부하를 줄이기 위해 글마다 대기 시간을 두고, 원본 서버에는 동시에 2개까지만 연결합니다. 설정에서 대기 시간을 지나치게 줄이지 마세요.</li>
          <li>짧은 시간에 과도하게 많은 글을 받거나 같은 목록을 반복해서 불러오지 마세요. 사이트 이용이 제한되거나 계정이 제재될 수 있습니다.</li>
          <li>아카라이브 이용약관과 각 채널의 규정을 준수해 주세요.</li>
        </ul>
        <h3>개인 보관용으로만 이용해 주세요</h3>
        <ul>
          <li>게시글과 이미지, 동영상의 권리는 각 작성자에게 있습니다. 내려받은 파일을 무단으로 다시 올리거나 배포하지 마세요.</li>
          <li>타인의 개인정보가 포함된 글은 각별히 주의해서 다뤄 주세요.</li>
        </ul>
        <h3>면책 안내</h3>
        <ul>
          <li>이 프로그램을 사용하여 발생하는 모든 결과의 책임은 사용자 본인에게 있습니다. 프로그램은 ‘있는 그대로’ 제공되며, 사이트 구조가 바뀌면 동작하지 않을 수 있습니다.</li>
          <li>로그인은 아카라이브 웹페이지에서 직접 진행되며, 언카라이브는 비밀번호를 읽거나 저장하지 않습니다.</li>
        </ul>
      </div>
      <label className="terms-agree">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} autoFocus />
        <span>위 내용을 모두 확인했으며, 이에 동의합니다.</span>
      </label>
      <div className="dialog-buttons">
        <button onClick={() => void call('quit')}>종료</button>
        <button className="primary" disabled={!agreed} onClick={() => void call('acceptTerms')}>확인</button>
      </div>
    </Dialog>
  );
}
