import { config } from '../config';

export const githubFetchTool = {
  definition: {
    name: 'github_fetch',
    description: '사용자의 GitHub 저장소 정보, README, 최근 커밋을 조회합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: '저장소 이름 (예: myClone)' },
        type: { type: 'string', description: '조회 타입: repos | readme | commits | all (기본값: repos)' },
      },
      required: [],
    },
  },

  async execute(input: { repo?: string; type?: string }): Promise<string> {
    const username = config.github.username;
    const token = config.github.token;

    if (!token || !username) {
      return '⚠️ GitHub 토큰이 설정되지 않았습니다. .env에서 GITHUB_TOKEN과 GITHUB_USERNAME을 설정하세요.';
    }

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
    };

    try {
      const type = input.type || 'repos';

      if (type === 'repos' || type === 'all') {
        const res = await fetch(`https://api.github.com/users/${username}/repos?sort=updated&per_page=10`, { headers });
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        const repos = await res.json() as Array<{
          name: string;
          description: string;
          language: string;
          stargazers_count: number;
          updated_at: string;
        }>;

        return repos.map(r =>
          `📁 **${r.name}** [${r.language || 'N/A'}] ⭐${r.stargazers_count}\n   ${r.description || '설명 없음'}\n   마지막 업데이트: ${new Date(r.updated_at).toLocaleDateString('ko-KR')}`
        ).join('\n\n');
      }

      if (type === 'readme' && input.repo) {
        const res = await fetch(`https://api.github.com/repos/${username}/${input.repo}/readme`, { headers });
        if (!res.ok) return `README를 찾을 수 없습니다: ${input.repo}`;
        const data = await res.json() as { content: string };
        return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 2000);
      }

      if (type === 'commits' && input.repo) {
        const res = await fetch(
          `https://api.github.com/repos/${username}/${input.repo}/commits?per_page=5`,
          { headers }
        );
        if (!res.ok) return `커밋 정보를 가져올 수 없습니다.`;
        const commits = await res.json() as Array<{
          sha: string;
          commit: { message: string; author: { date: string } };
        }>;

        return commits.map((c, i) =>
          `${i + 1}. ${c.commit.message.split('\n')[0]} (${new Date(c.commit.author.date).toLocaleDateString('ko-KR')})`
        ).join('\n');
      }

      return '지원하지 않는 조회 타입입니다.';
    } catch (err) {
      return `GitHub 조회 실패: ${err instanceof Error ? err.message : 'Unknown error'}`;
    }
  },
};
