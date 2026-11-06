import Foundation
import Testing
@testable import UncaliveCore

@Suite struct ParserTests {
    let postURL = URL(string: "https://arca.live/b/testchannel/1001")!

    @Test func 목록에서_머리글과_중복을_제외한다() throws {
        let page = try ArcaParser.parseScrapList(html: Fixture.html("scrap_list_page1"))
        #expect(page.entries.map(\.id) == ["1001", "1002"])
        #expect(page.entries[0].url.absoluteString == "https://arca.live/b/testchannel/1001")
        #expect(page.entries[0].title == "첫 번째 글")
        #expect(page.entries[0].author == "작성자A")
        #expect(page.entries[0].channelName == "테스트")
        #expect(page.entries[0].category == "질문")
        #expect(page.highestVisiblePage == 2)
        #expect(page.isLoggedIn)
        #expect(page.username == "테스트유저")
    }

    @Test func 빈_목록과_로그아웃을_구분한다() throws {
        let empty = try ArcaParser.parseScrapList(html: Fixture.html("scrap_list_empty"))
        #expect(empty.entries.isEmpty)
        #expect(empty.isLoggedIn)
        #expect(try ArcaParser.parseScrapList(html: Fixture.html("logged_out")).isLoggedIn == false)
    }

    @Test func 게시글_정보를_읽는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        #expect(post.id == "1001")
        #expect(post.channel == "testchannel")
        #expect(post.title == "첫 번째: 글/제목")
        #expect(post.category == "유머")
        #expect(post.author == "작성자A")
        #expect(post.createdAt == "2026-11-06T02:39:52.000Z")
    }

    @Test func 미디어를_본문_순서와_종류대로_읽는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        #expect(post.media.map(\.kind) == [.image, .poster, .video, .image, .emoticon])
        #expect(post.media[0].originalURL?.host() == "ac-o.arca.live")
        #expect(post.media[0].displayURL.scheme == "https")
    }

    @Test func 원본_주소를_먼저_시도한다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        let image = post.media[0]
        #expect(image.candidates(for: .original).map { $0.host() } == ["ac-o.arca.live", "ac.arca.live"])
        #expect(image.candidates(for: .display).map { $0.host() } == ["ac.arca.live"])
    }

    @Test func 원본_속성이_없으면_type_orig로_대체하되_외부_주소는_건드리지_않는다() throws {
        let arca = MediaRef(kind: .image, displayURL: URL(string: "https://ac.arca.live/a.jpg?key=1")!, originalURL: nil)
        #expect(arca.candidates(for: .original).first?.query()?.contains("type=orig") == true)
        let outside = MediaRef(kind: .image, displayURL: URL(string: "https://example.com/a.jpg")!, originalURL: nil)
        #expect(outside.candidates(for: .original).count == 1)
    }

    @Test func 원본_가로_크기를_읽는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        #expect(post.media[0].width == 10)
    }

    private func image(_ path: String, width: Int?) -> MediaRef {
        MediaRef(
            kind: .image,
            displayURL: URL(string: "https://ac.arca.live/\(path)")!,
            originalURL: URL(string: "https://ac-o.arca.live/\(path)")!,
            width: width
        )
    }

    @Test func 균형_화질은_축소되는_이미지만_원본으로_받는다() {
        #expect(image("a.jpg", width: 1280).prefersOriginal(.balanced) == false)
        #expect(image("a.png", width: 800).candidates(for: .balanced).first?.host() == "ac.arca.live")
        #expect(image("a.jpg", width: 1281).prefersOriginal(.balanced))
        #expect(image("a.jpg", width: 2508).candidates(for: .balanced).first?.host() == "ac-o.arca.live")
    }

    @Test func 균형_화질은_확신이_없으면_원본을_택한다() {
        #expect(image("a.jpg", width: nil).prefersOriginal(.balanced))
        #expect(image("a.gif", width: 300).prefersOriginal(.balanced))
        let video = MediaRef(kind: .video, displayURL: URL(string: "https://ac.arca.live/a.mp4")!, originalURL: nil, width: 300)
        #expect(video.prefersOriginal(.balanced))
    }

    @Test func 지연_로딩과_오디오와_내장_이미지를_놓치지_않는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_comment_pages"), url: postURL)
        #expect(post.media.map(\.kind) == [.audio, .image, .image])
        #expect(post.media[1].displayURL.lastPathComponent == "lazy.jpg")
        #expect(post.media[2].displayURL.scheme == "data")
        #expect(post.media[2].key.count < 80)
    }

    @Test func 외부_임베드와_댓글_페이지_수를_읽는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_comment_pages"), url: postURL)
        #expect(post.embeds.map(\.host) == [URL(string: "https://www.youtube.com")!.host])
        #expect(post.commentPages == 2)
    }

    @Test func 채널_목록에서_공지를_뺀다() throws {
        let page = try ArcaParser.parseScrapList(html: Fixture.html("channel_list"))
        #expect(page.entries.map(\.id) == ["3001", "3002"])
        #expect(page.highestVisiblePage == 2)
        #expect(page.entries[0].date != nil)
    }

    @Test func 붙여_넣은_주소를_구분한다() {
        let targets = ArcaParser.parseTargets("""
        https://arca.live/b/test/123?p=1#c_9 다른글자 https://example.com/b/test/5
        arca.live/b/test/123
        https://arca.live/b/test?mode=best
        http://arca.live/b/test/9
        """)
        #expect(targets.count == 2)
        if case .post(let entry) = targets[0] {
            #expect(entry.url.absoluteString == "https://arca.live/b/test/123")
        } else {
            Issue.record("글 주소로 읽지 못했습니다.")
        }
        #expect(targets[1] == .list(URL(string: "https://arca.live/b/test?mode=best")!))
    }

    @Test func 목록_주소의_조건을_유지하며_페이지를_바꾼다() {
        let url = ArcaParser.listURL(URL(string: "https://arca.live/b/test?mode=best&p=3")!, page: 2)
        #expect(url.absoluteString == "https://arca.live/b/test?mode=best&p=2")
    }

    @Test func 미디어_키는_서명이_바뀌어도_같다() {
        let first = MediaRef.key(for: URL(string: "https://ac.arca.live/a.jpg?expires=1&key=x")!)
        let second = MediaRef.key(for: URL(string: "https://ac.arca.live/a.jpg?expires=2&key=y")!)
        #expect(first == second)
    }

    @Test func 댓글과_답글_깊이를_읽는다() throws {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        #expect(post.comments.map(\.id) == ["11", "12"])
        #expect(post.comments.map(\.depth) == [0, 1])
        #expect(post.comments[0].messageHTML.contains("펼쳐보기") == false)
        #expect(post.comments[1].media.first?.kind == .emoticon)
    }

    @Test func 본문이_없으면_오류를_낸다() {
        #expect(throws: UncaliveError.contentNotFound) {
            try ArcaParser.parsePost(html: "<html><body></body></html>", url: postURL)
        }
    }
}

@Suite struct CSVTests {
    @Test func 쉼표와_따옴표와_줄바꿈을_감싼다() {
        #expect(CSVWriter.escape("a,b") == "\"a,b\"")
        #expect(CSVWriter.escape("그는 \"네\"") == "\"그는 \"\"네\"\"\"")
        #expect(CSVWriter.escape("평범한 제목") == "평범한 제목")
    }

    @Test func 수식으로_실행되지_않게_막는다() {
        #expect(CSVWriter.escape("=HYPERLINK(1)") == "'=HYPERLINK(1)")
        #expect(CSVWriter.escape("@cmd") == "'@cmd")
    }

    @Test func 엑셀용_BOM을_붙인다() {
        let data = CSVWriter.data(rows: [["제목"], ["글"]])
        #expect(Array(data.prefix(3)) == [0xEF, 0xBB, 0xBF])
        #expect(String(decoding: data.dropFirst(3), as: UTF8.self) == "제목\r\n글\r\n")
    }
}

@Suite struct FileNamingTests {
    @Test func 금지_문자와_앞뒤_공백_점을_정리한다() {
        #expect(FileNaming.sanitize(" ..a/b:c*d?\"e<f>g|h\\i.. ", maxCharacters: 80) == "a_b_c_d__e_f_g_h_i")
    }

    @Test func 잘린_뒤에도_끝에_공백이나_점이_남지_않는다() {
        #expect(FileNaming.sanitize("abc .def", maxCharacters: 5) == "abc")
    }

    @Test func 긴_한글_이름도_바이트_제한을_지킨다() {
        let name = FileNaming.sanitize(String(repeating: "가", count: 300), maxCharacters: 300)
        #expect(name.utf8.count <= 200)
    }

    @Test func 분해된_한글을_결합형으로_맞춘다() {
        #expect(FileNaming.sanitize("한글".decomposedStringWithCanonicalMapping, maxCharacters: 10) == "한글")
    }

    @Test func 순번은_전체_개수에_맞춰_자리를_맞춘다() {
        let media = MediaRef(kind: .image, displayURL: URL(string: "https://a.test/원본.jpg".addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed)!)!, originalURL: nil)
        #expect(FileNaming.baseName(sequence: 3, total: 9, media: media, naming: .sequence) == "03")
        #expect(FileNaming.baseName(sequence: 3, total: 120, media: media, naming: .sequence) == "003")
        #expect(FileNaming.baseName(sequence: 3, total: 9, media: media, naming: .sequenceAndOriginalName) == "03_원본")
    }
}

@Suite struct ArchiverTests {
    let postURL = URL(string: "https://arca.live/b/testchannel/1001")!

    private func rendered(paths: [String: String]) throws -> String {
        let post = try ArcaParser.parsePost(html: Fixture.html("post_full"), url: postURL)
        return try PostArchiver.render(post: post, paths: paths, includeComments: true)
    }

    private let allPaths = [
        "ac.arca.live/2026/photo.jpg": "01.jpg",
        "ac.arca.live/2026/clip.mp4": "02.mp4",
        "ac.arca.live/2026/clip.thumbnail.webp": "assets/poster.webp",
        "example.com/outside.png": "03.png",
        "ac.arca.live/2022/emo.png": "assets/emo.png",
        "ac.arca.live/2023/cemo.png": "assets/cemo.png"
    ]

    @Test func 받은_파일을_로컬_경로로_연결한다() throws {
        let html = try rendered(paths: allPaths)
        #expect(html.contains("src=\"01.jpg\""))
        #expect(html.contains("src=\"02.mp4\""))
        #expect(html.contains("poster=\"assets/poster.webp\""))
        #expect(html.contains("src=\"assets/cemo.png\""))
    }

    @Test func 서명_주소와_스크립트가_남지_않는다() throws {
        let html = try rendered(paths: allPaths)
        #expect(html.contains("expires=") == false)
        #expect(html.contains("ac-o.arca.live") == false)
        #expect(html.contains("alert(") == false)
        #expect(html.contains("onerror") == false)
        #expect(html.contains("javascript:") == false)
        #expect(html.contains("<iframe") == false)
        #expect(html.contains("https://www.youtube.com/embed/abc"))
        #expect(html.contains("href=\"https://arca.live/b/testchannel/1002\""))
    }

    @Test func 받지_않은_미디어는_안내문으로_바꾼다() throws {
        let html = try rendered(paths: [:])
        #expect(html.contains("[저장되지 않은 이미지]"))
        #expect(html.contains("[저장되지 않은 동영상]"))
        #expect(html.contains("<img") == false)
    }

    @Test func 제목의_HTML을_이스케이프한다() throws {
        let post = ParsedPost(id: "1", channel: "c", url: postURL, title: "<b>제목</b>", category: nil, author: nil, createdAt: nil, contentHTML: "", media: [], comments: [])
        let html = try PostArchiver.render(post: post, paths: [:], includeComments: false)
        #expect(html.contains("&lt;b&gt;제목"))
    }
}
