package question

import "testing"

func TestJobTagFromJD(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "short", in: "  Backend Go  ", want: "Backend Go"},
		{name: "exact40", in: string([]rune("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十")), want: string([]rune("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"))},
		{name: "truncate41", in: string([]rune("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一")), want: string([]rune("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十")) + "…"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := jobTagFromJD(tc.in)
			if got != tc.want {
				t.Fatalf("jobTagFromJD(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
